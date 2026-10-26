# Innotel fax portal

The replacement web experience for the fax plane. It is a TypeScript service
that owns the browser surface **and** the HylaFAX control path that AvantFAX's
PHP currently holds; the PHP app is retired page by page and switched off at
the end (the "full rewrite, cut over at the end" route).

```
browser ──▶ fax-portal (this service) ──▶ MariaDB `avantfax`  (read + write)
                     │                     HylaFAX spool       (documents)
                     └──▶ faxstat / sendfax (queue, delivery)
             auth:  Authentik OIDC, groups Zeus|Capstone
```

## Why this shape

* **The fax engine stays.** HylaFAX is the thing that talks to modems and DID
  lines; nothing about a UI rewrite should touch it. Everything that shells out
  lives in `src/hylafax.ts` so it can be swapped for a REST sidecar later
  without moving the rest of the app.
* **One schema, two UIs, during the migration.** The portal reads and writes
  the same `avantfax` tables, so the PHP UI keeps working while pages are moved
  across, and there is never a moment where two systems disagree about who owns
  a fax.
* **No client-side bundle to start with.** Server-rendered HTML with inline
  CSS (already dark-mode aware) means no hydration bugs, no build step in
  production, and a page that works on a locked-down phone browser. A client
  bundle can be added later for the parts that need it (live queue updates).
* **Auth is the same gate as today.** Authorization-code + PKCE against the
  `innotel-fax` Authentik application; the subscription check is group
  membership (`FAX_ALLOWED_GROUPS`), and admin rights are a second group list
  (`FAX_ADMIN_GROUPS`). Nothing is trusted from the URL. Endpoints come from the
  provider's discovery document — Authentik serves authorize/token from a shared
  path while the issuer is per application, so guessing them from the issuer
  yields a 404 that reads like a broken client.

## What exists now

| Route | Behaviour |
| --- | --- |
| `GET /healthz` | Liveness + database reachability. |
| `GET /auth/login` | Starts OIDC with PKCE; only same-origin `next` is honoured. |
| `GET /auth/callback` | Verifies state, exchanges the code, checks groups, sets a signed httpOnly session. |
| `GET /auth/logout` | Drops the session and ends the Authentik session. |
| `GET /` | Inbox for the signed-in account + the live sending queue. |
| `POST /fax/send` | Multipart upload: E.164 check → quarantine → Ghostscript → `sendfax`. |
| `GET /fax/:id` | The archived PDF inline, scoped to the owner (404 for anyone else's). |
| `GET /search?q=` | Full-text search over extracted fax text, own faxes only. |
| `GET /outbox` | Every send this account made, with delivery state. |
| `GET`, `POST /contacts` | The account's address book; `POST /contacts/:id/delete` removes one. |
| `GET`, `POST /cover-pages` | Cover page templates; `POST /cover-pages/:id/delete` removes one. |
| `GET /triage` | Automatic classification, with overrides. |
| `POST /triage/:faxid` | Record a human decision (the original stays in the audit trail). |
| `GET /admin` | Admin console: accounts, lines, webhooks, recent changes. |
| `GET /admin/accounts`, `POST /admin/accounts/:uid/:change` | Enable, disable, grant or revoke administrator. |
| `GET /admin/lines`, `POST /admin/lines`, `POST /admin/lines/:id/:change` | DID lines and their routing. |
| `GET`, `POST /admin/webhooks` | List endpoints / create one (returns its signing secret once). |
| `POST /admin/webhooks/:id/delete` | Remove an endpoint and its pending retries. |
| `POST /hooks/inbound-email` | Email-to-fax: `x-inbound-secret`, raw MIME in, PDF attachment out. |

Accounts are provisioned on first sign-in from the SSO identity (email-matched,
unique username derived from the handle), so no one shares a generic login.

### Document upload

Nothing the browser sends is passed to HylaFAX. `src/pipeline.ts` streams the
upload into a quarantine directory under a hard byte cap, checks the magic bytes
(`%PDF-`), hashes it, then hands it to Ghostscript with `-dSAFER` and writes a
fresh PDF into the spool's `tmp` directory. `sendfax` receives **that** file and
nothing else, so a polyglot or a mislabelled binary never reaches the fax queue.
The ledger row records the hash, page count and HylaFAX request id, and the spool
copy is pruned after a day.

### Webhooks

`fax.queued`, `fax.sent` and `fax.failed`, delivered as JSON with a
Stripe-shaped `X-Innotel-Signature: t=<unix>,v1=<hex-hmac>` header (the HMAC
covers `timestamp.payload`, so a captured delivery cannot be replayed). Failures
retry with exponential backoff for roughly a day before being parked.

### Email-to-fax

The mail transport posts the raw message to `/hooks/inbound-email` with the
shared secret. The recipient is the fax number — either `+15551234567@…` in the
`To` header or an E.164 number in the subject — and the sender must already be a
fax account. Only the PDF *attachment* (found by magic bytes, not by filename)
goes through the same quarantine and normalisation as a web upload.

### Cover pages

A cover page is a **template**, not an upload. `src/cover.ts` fills `{{to}}`,
`{{from}}`, `{{date}}`, `{{subject}}` and `{{pages}}`, escapes the result into
PostScript, renders it with Ghostscript and merges it in front of the document,
which is then sent as one PDF. A template can only contribute text: parentheses
and backslashes are escaped, so a cover page cannot inject PostScript operators
or a second document into the spool. Unknown placeholders are rejected when the
template is saved.

### Triage

The optional classify pass (`FAX_TRIAGE_*`) sends the extracted text of a
received fax to an OpenAI-compatible chat-completions endpoint and stores one
of a closed set of categories with a confidence. Below `FAX_TRIAGE_MIN_CONFIDENCE`
the row is marked **needs review** instead of being used. Every decision is
written to `PortalTriage` with provider, model, prompt version and a hash of the
input; a human override is appended to `PortalTriageOverride` with who and why,
so the automated call is never overwritten out of history. The prompt marks the
fax as untrusted data, and the parser only accepts a category from the closed
set — a hostile document can be miscategorised, but it cannot instruct the
portal.

With no API key the feature is off and no fax text leaves the server.

**What a decision does.** A confident category is *filed*: the fax is labelled
with the category (visible in the inbox, filterable later) and the customer's
webhooks are told. An uncertain or failed classification is *flagged* for a
human and nothing is filed. Every step is appended to `PortalTriageAction` with
the actor (`auto:<provider>/<model>` or an email address), so "why is this fax
filed under legal?" has an answer with a timestamp. A human override replaces
the automatic label — both the original and the override stay in the record.

### Admin console

`/admin` is real now: **accounts** (enable/disable, grant or revoke
administrator), **lines** (DID numbers, assigned to the account that should
receive their fax) and the webhook endpoints. Two guards matter: an
administrator cannot disable or demote themselves, and the last enabled
administrator cannot be demoted or disabled by anyone. Every change is written
to `PortalAudit` with who made it. Line routing is the table the portal applies
once it owns reception (phase 4); until then AvantFAX still sets the owner of an
arriving fax.

### Archive search

A background sweep extracts text from archived faxes with `pdftotext` and, when
`FAX_OCR_BIN` is set, falls back to an OCR pass for scans. Text is stored in
`PortalFaxText` with a MySQL full-text index; `/search` queries it with results
scoped to the signed-in account (administrators see everything).

## Phases

1. **Client parity — done.** Upload → quarantine → normalisation → `sendfax`,
   archive viewer, archive search, live queue. Still in PHP: contacts, cover
   pages, outbox history.
2. **Notifications and hooks — done.** Signed webhooks for
   `fax.queued`/`fax.sent`/`fax.failed`, delivery tracking off `faxstat`, and
   email-to-fax inbound. Not yet built: SMS/email delivery notices.
3. **Intelligence — done.** Full-text search with OCR fallback, plus optional
   LLM classification with confidence gating, an append-only audit trail and
   human override. Not yet built: rules that *act* on the category (file to a
   folder, route to a queue) — classification is visible, not autonomous.
4. **Admin parity, then cut-over (next).** Accounts, lines and DID routing are
   served here with an audit trail. Still PHP: retention policy, cover page
   administration, audit export, modem/scheduler management. When those are
   served here, the NPM host flips from `zeus-freepbx:/fax` to this service and
   the PHP tree is removed.

The product is deployed and clickable on staging (see **Staging** above); nothing
is cut over until phase 4 is served here.

## Running it

```sh
cp .env.example .env      # fill in the client secret, DB password, session secret
npm install
npm run typecheck
npm test
npm run smoke:pipeline    # real Ghostscript + stub sendfax, proves the send path
npm run signin:e2e        # browser sign-in against staging (see below)
npm start                 # or: docker build -t innotel/fax-portal .
```

Register `https://fax.pbx.services/auth/callback` as a redirect URI on the
`innotel-fax` Authentik provider before the first sign-in.

## Staging

```sh
cd deploy/staging
./up.sh                   # preflight, .env with fresh secrets, build, start, wait for /healthz
python3 provision-sso.py  # create/repair the "Innotel Fax Staging" OIDC client
```

`up.sh` runs `preflight.sh` first — typecheck, the test suite, then the browser
sign-in check against the stack that is live *now* — and stops before the build
if any of them fails; a broken portal is a reason not to replace the image, and
shipping over it would hide the cause. `SKIP_PREFLIGHT=1 ./up.sh` deploys
anyway, `SKIP_SIGNIN=1 ./preflight.sh` skips only the browser leg (for when
Authentik is unreachable and only the build is being validated — the script says
so in its output).

The same preflight runs daily as `fax-preflight.timer` (units in
`deploy/staging/systemd`, `journalctl -u fax-preflight.service` for the last
result), so a break in the sign-in path shows up as a failed unit before anyone
deploys on top of it.

Staging runs at **https://fax-staging.lab.innotel.us** (NPM proxy host, wildcard
`*.lab.innotel.us` certificate) on top of its own MariaDB and its own archive
volume. Triage is live there against the estate's model gateway
(`FAX_TRIAGE_BASE_URL=https://gateway.innotel.us/v1`, model
`kilo-gateway/kilo-auto/free`), so a fax that lands on staging is indexed,
classified, filed and announced for real — at no model cost. Free routes are
chosen by measurement, not by name: `auto/best-free` looks like the right alias
but its first pick (a Cloudflare Playground provider) answers 502 because the
gateway host has no Playwright browser, the scraped DuckDuckGo models answer 429
within a call or two, and `ovh`'s free Mistral rate-limits and misread a plain
note as an invoice. `kilo-auto/free` parsed 12/12 with a 1.6 s median.
Two things there are deliberately not production:

* **The fax transport is a stub** (`deploy/staging/bin`). `sendfax` prints a
  request id instead of dialling; `faxstat` reports a fixed queue. Everything
  around it — quarantine, Ghostscript, merge, job ledger, webhooks — is the real
  code, so the send path is exercised without a modem or a phone bill.
* **The database is a copy of the schema shape**, seeded with
  `stage-client@lab.innotel.us` and `stage-admin@lab.innotel.us`, never
  production customers.

Sign-in reaches Authentik at its public name — that name is the token issuer and
is never rewritten — but the name is pinned to the reverse proxy's LAN address
(`FAX_OIDC_INTERNAL_ADDR`, default `192.168.1.71`) in the portal container's
hosts file. Through the WAN address the router's hairpin NAT completes TCP and
the TLS handshake but returns no HTTP response to traffic from a docker bridge,
so discovery and the code exchange simply hang: every sign-in failed with "the
identity provider rejected the exchange" while the IdP was healthy.

Two things about this Authentik that cost an afternoon and are easy to hit
again. First, the issuer is not spelled consistently: discovery and
client-credentials tokens carry `…/application/o/<slug>/`, while id tokens from
the `authorization_code` flow have been seen both with and without the trailing
slash. The portal therefore accepts either spelling of the configured issuer —
both are compared exactly, so a foreign issuer still fails — and a rejection
logs the `iss`/`aud` it actually saw. Second, `loadConfig` strips the trailing
slash from `FAX_OIDC_ISSUER`, so the accepted set has to be rebuilt from the
normalised value (`src/auth.ts`); deriving one spelling from the other left a
single candidate and the fallback never ran, which is exactly how a healthy
provider produced "the identity provider rejected the exchange". `/healthz` also
reports `oidc: ok|unreachable` (and logs when it changes): it never changes the
status code, because an issuer outage must not restart a portal that can still
serve faxes.

### Proving sign-in

Nothing about this path is provable with curl: discovery, PKCE, the code
exchange, the group check and the session cookie all have to work in one
browser redirect chain. `npm run signin:e2e` drives Chromium through Authentik
with a throwaway user it creates in `FAX_E2E_GROUP` (default `Zeus`), asserts
that the inbox is served for that identity with an httpOnly session cookie,
that signing out clears it, then deletes the user. It reads the Authentik API
credentials the same way `provision-sso.py` does.

```sh
AUTHENTIK_ENV_FILE=/root/.cerulean-env npm run signin:e2e
# --headed shows the flow; --keep-user leaves the probe account behind
# FAX_E2E_PORTAL points it at another origin; FAX_E2E_DB_URL (mysql://…) is for
# a portal whose database this host cannot reach through its container
```

Against the staging stack it also deletes the account row the portal provisions
on first sign-in: staging's MariaDB is not published, so the row goes through the
`fax-staging-db-1` container's own client, using the password in
`deploy/staging/.env`. Nothing is deleted unless the portal under test is that
stack's `FAX_PUBLIC_ORIGIN`.

`deploy/staging/.env` holds generated secrets and is git-ignored. If the host's
clock has drifted (compare `date -u` with any HTTP `Date:` header), `apt-get`
refuses the Debian release files and the image build stops: run
`APT_CHECK_DATE=false ./up.sh` on that host, and fix the clock before trusting
any OIDC login it serves.
`provision-sso.py --check` reports drift without writing.

## Deliberate gaps

* **The admin console is a placeholder** until phase 4 — the PHP admin remains
  the working one during the migration. Webhook management is the one admin
  surface that is live here, because nothing else owns it.
* **The viewer serves the PDF inline**, not per-page rendered images. Browsers
  and the phone preview already render it; per-page rendering waits until a
  reason to build it appears.
* **Contacts and cover pages live in portal-owned tables** (`PortalContact`,
  `PortalCoverPage`), not the PHP ones. At cut-over they are copied from the
  legacy tables once; until then the PHP app has its own copy and the portal
  does not write to it.
* **Tests do not fork real HylaFAX.** The pipeline is covered with an injected
  runner; `npm run smoke:pipeline` exercises the real Ghostscript path against a
  stub `sendfax`, and a deployment should run it once on the target host.
* **Triage acts on filing only.** It can label a fax and notify a webhook. It
  cannot delete, forward, re-send or change who owns a fax — a wrong category
  costs a wrong label, which a human can fix, and the fix is recorded.
* **Triage is off until a key is configured.** With `FAX_TRIAGE_API_KEY` empty
  the Review page stays empty and no fax text leaves the server; that is the
  intended default, not an unfinished feature.
