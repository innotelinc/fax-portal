import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.ts";
import { Auth, NotSubscribed, ProviderUnreachable, type Identity } from "./auth.ts";
import { Database, type Account } from "./db.ts";
import { canChangeAccount, CHANGE_LABEL, type AccountChange } from "./admin.ts";
import { normaliseFaxNumber } from "./numbers.ts";
import { classifyFaxstatState, Hylafax, visibleQueue } from "./hylafax.ts";
import { acceptUpload, pruneSpool, type PipelineOptions, type Runner } from "./pipeline.ts";
import { PortalStore, type TriageDecision } from "./store.ts";
import { drain } from "./webhooks.ts";
import { sweep, type Extractor } from "./ocr.ts";
import { addressOf, destinationOf, parseMessage } from "./email-to-fax.ts";
import { PLACEHOLDERS, unknownPlaceholders } from "./cover.ts";
import { CATEGORIES, sweepTriage } from "./triage.ts";
import { describeAction, planActions } from "./actions.ts";
import {
  adminAccountsPage,
  adminLinesPage,
  adminPage,
  contactsPage,
  coverPagesPage,
  deniedPage,
  errorPage,
  inboxPage,
  outboxPage,
  searchPage,
  triagePage,
} from "./ui.ts";

const config = loadConfig();
const auth = new Auth(config);
const db = new Database(config);
const hylafax = new Hylafax(config);
const store = new PortalStore(db.connectionPool());

const run: Runner = async (command, args, timeoutMs) => {
  const { stdout, stderr } = await promisify(execFile)(command, [...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
};

const uploadPipeline: PipelineOptions = {
  quarantineDir: config.hylafax.quarantineDir,
  // Normalised documents are staged in HylaFAX's tmp directory, which the fax
  // user owns. The browser-supplied file never lands there.
  spoolDir: join(config.hylafax.spoolDir, "tmp"),
  callerId: config.hylafax.callerId,
  ghostscriptBin: config.hylafax.ghostscriptBin,
  sendfaxBin: join(config.hylafax.binDir, "sendfax"),
  ledger: store,
  run,
};

const EVENTS = ["fax.queued", "fax.sent", "fax.failed", "fax.triaged"] as const;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cookie);
await app.register(formbody);
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 8, parts: 10 },
});

/**
 * Raw MIME for the mail transport. Parsed as a buffer because the parser in
 * email-to-fax.ts is the only thing that decides what counts as an attachment;
 * letting Fastify guess at a content type here would be a second opinion.
 */
app.addContentTypeParser(
  ["message/rfc822", "application/octet-stream"],
  { parseAs: "buffer" },
  (_request, body, done) => done(null, body),
);

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity | null;
  }
}

app.decorateRequest("identity", null);

app.addHook("onRequest", async (request) => {
  request.identity = await auth.readSession(request.cookies[auth.cookieName]);
});

/** Only same-origin paths are accepted as a post-login destination. */
function safeNext(value: unknown): string {
  const candidate = typeof value === "string" ? value : "";
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}

function wantsJson(request: { headers: Record<string, unknown> }): boolean {
  const accept = String(request.headers.accept ?? "");
  return accept.includes("application/json");
}

async function accountFor(identity: Identity) {
  return db.accountForIdentity({
    email: identity.email,
    username: identity.username,
    displayName: identity.displayName,
    isAdmin: identity.isAdmin,
  });
}

/** Emit an event without ever letting a webhook problem fail the request. */
function emit(event: string, payload: unknown): void {
  void store.enqueueEvent(event, payload).catch((error: unknown) => {
    app.log.warn({ err: error, event }, "could not queue webhook event");
  });
}

/**
 * Act on a classification. Every step is written to PortalTriageAction, so the
 * question "why is this fax filed under legal?" has an answer with a timestamp.
 */
async function applyDecision(decision: TriageDecision): Promise<void> {
  const plan = planActions(decision);
  const actor = `auto:${decision.provider}/${decision.model}`;
  try {
    if (plan.label) {
      await store.fileFaxLabel(decision.faxid, plan.label, "auto");
    }
    for (const line of describeAction(plan, decision)) {
      const action = line.startsWith("filed") ? "filed" : line.startsWith("flagged") ? "flagged" : "notified";
      await store.recordAction(decision.faxid, action, line, actor);
    }
    if (plan.notify) {
      emit("fax.triaged", {
        faxid: decision.faxid,
        category: decision.category,
        counterparty: decision.counterparty,
        confidence: decision.confidence,
        status: decision.status,
        label: plan.label,
        source: "auto",
      });
    }
  } catch (error) {
    app.log.warn({ err: error, faxid: decision.faxid }, "could not apply triage actions");
  }
}

app.get("/healthz", async (request, reply) => {
  const healthy = await db.healthcheck();
  // Sign-in is not allowed to decide the status code: a restart loop because
  // the identity provider is briefly unreachable would take the whole portal
  // down, including the faxes it can still serve. It is reported, and logged
  // when it changes, so a broken issuer path is visible before the first login.
  const oidc = await auth.reachable();
  if (!oidc.ok && lastOidcState !== false) {
    request.log.error({ detail: oidc.detail }, "identity provider unreachable; sign-in will fail");
  } else if (oidc.ok && lastOidcState === false) {
    request.log.info("identity provider reachable again");
  }
  lastOidcState = oidc.ok;
  reply.code(healthy ? 200 : 503);
  return {
    status: healthy ? "ok" : "degraded",
    database: healthy,
    oidc: oidc.ok ? "ok" : "unreachable",
    ...(oidc.ok ? {} : { oidcError: oidc.detail }),
  };
});

app.get("/", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect(`/auth/login?next=${encodeURIComponent("/")}`);
  }
  const account = await accountFor(request.identity);
  if (!account.enabled) {
    return reply
      .code(403)
      .type("text/html")
      .send(deniedPage("Account disabled", "This fax account has been disabled by an administrator.", request.identity));
  }
  const query = request.query as Record<string, unknown>;
  const [faxes, queue, mine, contacts, coverPages, labels] = await Promise.all([
    db.inbox(account),
    hylafax.queue().catch(() => []),
    store.hylafaxJobsForAccount(account.uid).catch(() => []),
    store.contacts(account.uid).catch(() => []),
    store.coverPages(account.uid).catch(() => []),
    store.labelsForAccount(account.uid, account.isAdmin).catch(() => new Map<number, string>()),
  ]);
  // faxstat lists every job on the server; a client only gets to see their own.
  const jobs = visibleQueue(queue, new Set(mine), account.isAdmin);

  let notice: { kind: "ok" | "error"; text: string } | null = null;
  if (typeof query.queued === "string") {
    notice = { kind: "ok", text: `Fax accepted by the server and queued as job ${query.queued}.` };
  } else if (typeof query.error === "string") {
    notice = { kind: "error", text: query.error.slice(0, 300) };
  }

  return reply.type("text/html").send(
    inboxPage(request.identity, account, faxes, jobs, notice, {
      contacts,
      coverPages,
      labels,
      ...(typeof query.to === "string" ? { prefillTo: query.to } : {}),
    }),
  );
});

/** Last reported reachability, so the log records changes rather than polls. */
let lastOidcState: boolean | null = null;

app.get("/auth/login", async (request, reply) => {
  const next = safeNext((request.query as Record<string, unknown>).next);
  let started: Awaited<ReturnType<Auth["begin"]>>;
  try {
    started = await auth.begin(next);
  } catch (error) {
    request.log.error({ err: error }, "oidc discovery failed");
    return reply
      .code(502)
      .type("text/html")
      .send(errorPage("Sign-in unavailable", "The identity provider could not be reached. Try again shortly."));
  }
  const { url, pending } = started;
  reply.setCookie(auth.pendingCookieName, await auth.signPending(pending), {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
  });
  return reply.redirect(url);
});

app.get("/auth/callback", async (request, reply) => {
  const query = request.query as Record<string, unknown>;
  const code = typeof query.code === "string" ? query.code : "";
  const state = typeof query.state === "string" ? query.state : "";
  const pending = await auth.readPending(request.cookies[auth.pendingCookieName]);

  if (!code || !pending || pending.state !== state) {
    return reply.code(400).type("text/html").send(errorPage("Sign-in expired", "The sign-in attempt could not be verified. Start again."));
  }

  try {
    const identity = await auth.complete(code, pending);
    reply.clearCookie(auth.pendingCookieName, { path: "/" });
    reply.setCookie(auth.cookieName, await auth.issueSession(identity), {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: auth.sessionTtlSeconds,
    });
    return reply.redirect(safeNext(pending.redirectTo));
  } catch (error) {
    if (error instanceof NotSubscribed) {
      return reply
        .code(403)
        .type("text/html")
        .send(
          deniedPage(
            "Fax is not enabled",
            `Sign-in worked, but ${error.email} is not subscribed to Zeus or Capstone, which is what the fax service is sold with.`,
            null,
          ),
        );
    }
    request.log.error({ err: error }, "oidc callback failed");
    if (error instanceof ProviderUnreachable) {
      return reply
        .code(503)
        .type("text/html")
        .send(errorPage("Sign-in unavailable", "The portal could not reach the identity provider. Try again shortly."));
    }
    return reply.code(502).type("text/html").send(errorPage("Sign-in failed", "The identity provider rejected the exchange."));
  }
});

app.get("/auth/logout", async (_request, reply) => {
  reply.clearCookie(auth.cookieName, { path: "/" });
  return reply.redirect(await auth.logoutUrl());
});

/**
 * Upload → quarantine → Ghostscript → sendfax.
 *
 * The form posts `to` before the document, and this route relies on that: the
 * file stream is handed to the pipeline as it arrives instead of being buffered
 * in memory, which is what keeps a 25 MB upload from becoming 25 MB of heap per
 * concurrent sender.
 */
app.post("/fax/send", async (request, reply) => {
  if (!request.identity) {
    return wantsJson(request) ? reply.code(401).send({ error: "unauthenticated" }) : reply.redirect("/auth/login");
  }
  const account = await accountFor(request.identity);
  if (!account.enabled) {
    return reply.code(403).send({ error: "account disabled" });
  }
  if (!request.isMultipart()) {
    return reply.code(415).send({ error: "expected multipart/form-data" });
  }

  const fail = async (status: number, message: string) => {
    if (wantsJson(request)) {
      return reply.code(status).send({ error: message });
    }
    return reply.redirect(`/?error=${encodeURIComponent(message)}`);
  };

  let to = "";
  let coverPageId = 0;
  for await (const part of request.parts()) {
    if (part.type === "field") {
      if (part.fieldname === "to") {
        to = String(part.value).trim();
      }
      if (part.fieldname === "coverPageId") {
        coverPageId = Number.parseInt(String(part.value), 10) || 0;
      }
      continue;
    }

    if (part.fieldname !== "document") {
      part.file.resume();
      continue;
    }

    if (!to) {
      part.file.resume();
      return fail(400, "send the fax number before the document");
    }
    const destination = normaliseFaxNumber(to);
    if (!destination) {
      part.file.resume();
      return fail(400, "fax numbers must be in E.164 form, e.g. +15551234567");
    }

    let cover: { title: string; body: string } | undefined;
    if (coverPageId > 0) {
      const page = await store.coverPage(account.uid, coverPageId);
      if (!page) {
        part.file.resume();
        return fail(400, "that cover page does not exist");
      }
      cover = { title: page.name, body: page.body };
    }

    const result = await acceptUpload(uploadPipeline, account.uid, destination, {
      stream: part.file,
      filename: part.filename,
      ...(cover ? { cover } : {}),
    }).catch((error: unknown) => {
      // A storage problem (full disk, wrong ownership) is not the sender's
      // fault and must not read as a 500 with a stack trace.
      request.log.error({ err: error }, "fax upload failed before the pipeline could record it");
      return { ok: false, code: 503, reason: "the fax server could not store the document" } as const;
    });

    if (!result.ok) {
      request.log.warn({ reason: result.reason, to }, "fax rejected");
      return fail(result.code, result.reason);
    }

    request.log.info({ jobId: result.jobId, hylafaxJob: result.hylafaxJob, to, by: account.email }, "fax queued");
    emit("fax.queued", {
      jobId: result.jobId,
      hylafaxJob: result.hylafaxJob,
      to,
      pages: result.pages,
      account: account.email,
    });

    if (wantsJson(request)) {
      return reply.code(202).send({ ok: true, jobId: result.jobId, hylafaxJob: result.hylafaxJob, pages: result.pages });
    }
    return reply.redirect(`/?queued=${encodeURIComponent(result.hylafaxJob)}`);
  }

  return fail(400, "no document was uploaded");
});

app.get("/fax/:id", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login");
  }
  const account = await accountFor(request.identity);
  const id = Number.parseInt(String((request.params as Record<string, unknown>).id ?? ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: "invalid fax id" });
  }
  const file = await db.faxFile(id, account, config.hylafax.archiveDir);
  if (!file) {
    return reply.code(404).type("text/html").send(errorPage("Fax not found", "That fax does not exist, or it belongs to another account."));
  }
  try {
    await stat(file.path);
  } catch {
    return reply.code(410).type("text/html").send(errorPage("Document missing", "The archive record exists but its PDF is not on disk."));
  }
  return reply
    .type("application/pdf")
    .header("content-disposition", `inline; filename="fax-${id}.pdf"`)
    .header("x-content-type-options", "nosniff")
    .send(createReadStream(file.path));
});

app.get("/search", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect(`/auth/login?next=${encodeURIComponent("/search")}`);
  }
  const account = await accountFor(request.identity);
  const raw = (request.query as Record<string, unknown>).q;
  const query = typeof raw === "string" ? raw.trim().slice(0, 200) : "";

  const hits = query.length >= 2 ? await store.search(account.uid, account.isAdmin, query) : [];
  const indexed = await store.countText(account.uid, account.isAdmin).catch(() => 0);
  return reply.type("text/html").send(searchPage(request.identity, query, hits, indexed));
});

/**
 * Every admin surface starts here: signed in, and actually an administrator.
 * The check reads the account row, not the session, so revoking the role takes
 * effect on the next request instead of when the cookie expires.
 */
async function adminOnly(
  request: { identity: Identity | null; log: { warn: (payload: object, message: string) => void } },
  reply: { code: (status: number) => { type: (value: string) => { send: (body: string) => unknown } } },
): Promise<Account | null> {
  if (!request.identity) {
    return null;
  }
  const account = await accountFor(request.identity);
  if (!account.isAdmin || !account.enabled) {
    reply
      .code(403)
      .type("text/html")
      .send(
        deniedPage(
          "Administrators only",
          "This account is not an administrator for the fax server.",
          request.identity,
        ),
      );
    return null;
  }
  return account;
}

app.get("/admin", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect(`/auth/login?next=${encodeURIComponent("/admin")}`);
  }
  const account = await adminOnly(request, reply);
  if (!account) {
    return reply;
  }
  const [accounts, lines, audits] = await Promise.all([
    store.accounts(),
    store.lines(),
    store.auditRows(10),
  ]);
  return reply.type("text/html").send(
    adminPage(request.identity, { accounts: accounts.length, lines: lines.length, audits }),
  );
});

app.get("/admin/accounts", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login?next=%2Fadmin%2Faccounts");
  }
  const account = await adminOnly(request, reply);
  if (!account) {
    return reply;
  }
  const accounts = await store.accounts();
  const query = request.query as Record<string, unknown>;
  const notice =
    typeof query.done === "string"
      ? { kind: "ok" as const, text: query.done.slice(0, 200) }
      : typeof query.error === "string"
        ? { kind: "error" as const, text: query.error.slice(0, 200) }
        : null;
  return reply.type("text/html").send(adminAccountsPage(request.identity, accounts, account.uid, notice));
});

app.post("/admin/accounts/:uid/:change", async (request, reply) => {
  const actor = await adminOnly(request, reply);
  if (!actor) {
    return reply;
  }
  const params = request.params as Record<string, unknown>;
  const targetUid = Number.parseInt(String(params.uid ?? ""), 10);
  const change = String(params.change ?? "") as AccountChange;
  if (!Number.isInteger(targetUid) || !(change in CHANGE_LABEL)) {
    return reply.redirect(`/admin/accounts?error=${encodeURIComponent("unknown account or change")}`);
  }

  const accounts = await store.accounts();
  const target = accounts.find((entry) => entry.uid === targetUid);
  if (!target) {
    return reply.redirect(`/admin/accounts?error=${encodeURIComponent("no such account")}`);
  }

  const self = accounts.find((entry) => entry.uid === actor.uid) ?? {
    uid: actor.uid,
    username: actor.username,
    name: actor.name,
    email: actor.email,
    isAdmin: actor.isAdmin,
    enabled: actor.enabled,
  };
  const verdict = canChangeAccount(self, target, change, accounts);
  if (!verdict.allowed) {
    return reply.redirect(`/admin/accounts?error=${encodeURIComponent(verdict.reason ?? "not allowed")}`);
  }

  switch (change) {
    case "enable":
      await store.setAccountEnabled(targetUid, true);
      break;
    case "disable":
      await store.setAccountEnabled(targetUid, false);
      break;
    case "grant-admin":
      await store.setAccountAdmin(targetUid, true);
      break;
    case "revoke-admin":
      await store.setAccountAdmin(targetUid, false);
      break;
  }
  await store.audit(actor.email, `account.${change}`, target.email, CHANGE_LABEL[change]);
  return reply.redirect(`/admin/accounts?done=${encodeURIComponent(`${target.email} ${CHANGE_LABEL[change]}`)}`);
});

app.get("/admin/lines", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login?next=%2Fadmin%2Flines");
  }
  const actor = await adminOnly(request, reply);
  if (!actor) {
    return reply;
  }
  const [lines, accounts] = await Promise.all([store.lines(), store.accounts()]);
  const query = request.query as Record<string, unknown>;
  const notice =
    typeof query.done === "string"
      ? { kind: "ok" as const, text: query.done.slice(0, 200) }
      : typeof query.error === "string"
        ? { kind: "error" as const, text: query.error.slice(0, 200) }
        : null;
  return reply.type("text/html").send(adminLinesPage(request.identity, lines, accounts, notice));
});

app.post("/admin/lines", async (request, reply) => {
  const actor = await adminOnly(request, reply);
  if (!actor) {
    return reply;
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  const number = normaliseFaxNumber(body.number);
  if (!number) {
    return reply.redirect(`/admin/lines?error=${encodeURIComponent("a line needs an E.164 number")}`);
  }
  const label = String(body.label ?? "").trim().slice(0, 120);
  const accountUid = Number.parseInt(String(body.accountUid ?? ""), 10);
  const target = Number.isInteger(accountUid) && accountUid > 0 ? accountUid : null;
  try {
    await store.addLine(number, label, target);
  } catch (error) {
    const duplicate = (error as { code?: string }).code === "ER_DUP_ENTRY";
    return reply.redirect(
      `/admin/lines?error=${encodeURIComponent(duplicate ? `${number} is already a line` : "the line could not be saved")}`,
    );
  }
  await store.audit(actor.email, "line.added", number, label || "no label");
  return reply.redirect(`/admin/lines?done=${encodeURIComponent(`${number} added`)}`);
});

app.post("/admin/lines/:id/:change", async (request, reply) => {
  const actor = await adminOnly(request, reply);
  if (!actor) {
    return reply;
  }
  const params = request.params as Record<string, unknown>;
  const id = Number.parseInt(String(params.id ?? ""), 10);
  const change = String(params.change ?? "");
  if (!Number.isInteger(id) || id <= 0) {
    return reply.redirect(`/admin/lines?error=${encodeURIComponent("no such line")}`);
  }
  const lines = await store.lines();
  const line = lines.find((entry) => entry.id === id);
  if (!line) {
    return reply.redirect(`/admin/lines?error=${encodeURIComponent("no such line")}`);
  }

  switch (change) {
    case "assign": {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const requested = Number.parseInt(String(body.accountUid ?? ""), 10);
      const target = Number.isInteger(requested) && requested > 0 ? requested : null;
      if (target !== null && !(await store.accounts()).some((entry) => entry.uid === target)) {
        return reply.redirect(`/admin/lines?error=${encodeURIComponent("no such account")}`);
      }
      await store.assignLine(id, target);
      await store.audit(actor.email, "line.assigned", line.number, target === null ? "unassigned" : `to uid ${target}`);
      return reply.redirect(`/admin/lines?done=${encodeURIComponent(`${line.number} routed`)}`);
    }
    case "enable":
    case "disable":
      await store.setLineEnabled(id, change === "enable");
      await store.audit(actor.email, `line.${change}d`, line.number, "");
      return reply.redirect(`/admin/lines?done=${encodeURIComponent(`${line.number} ${change}d`)}`);
    case "delete":
      await store.deleteLine(id);
      await store.audit(actor.email, "line.deleted", line.number, line.label);
      return reply.redirect(`/admin/lines?done=${encodeURIComponent(`${line.number} deleted`)}`);
    default:
      return reply.redirect(`/admin/lines?error=${encodeURIComponent("unknown change")}`);
  }
});

app.get("/admin/webhooks", async (request, reply) => {
  const account = await adminOnly(request, reply);
  if (!account) {
    return reply;
  }
  const hooks = await store.webhooks();
  return { webhooks: hooks.map((hook) => ({ id: hook.id, url: hook.url, events: hook.events })) };
});

app.post("/admin/webhooks/:id/delete", async (request, reply) => {
  const actor = await adminOnly(request, reply);
  if (!actor) {
    return reply;
  }
  const id = Number.parseInt(String((request.params as Record<string, unknown>).id ?? ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: "invalid webhook id" });
  }
  const removed = await store.deleteWebhook(id);
  if (!removed) {
    return reply.code(404).send({ error: "no such webhook" });
  }
  await store.audit(actor.email, "webhook.deleted", `webhook ${id}`, "endpoint and its pending deliveries removed");
  return reply.code(204).send();
});

app.post("/admin/webhooks", async (request, reply) => {
  const admin = await adminOnly(request, reply);
  if (!admin) {
    return reply;
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reply.code(400).send({ error: "url must be absolute" });
  }
  if (parsed.protocol !== "https:") {
    return reply.code(400).send({ error: "webhooks must use https" });
  }
  const requested = Array.isArray(body.events) ? body.events.map(String) : [];
  const events = requested.filter((event): event is (typeof EVENTS)[number] =>
    (EVENTS as readonly string[]).includes(event),
  );
  if (events.length === 0) {
    return reply.code(400).send({ error: `events must include at least one of ${EVENTS.join(", ")}` });
  }
  const secret = randomBytes(32).toString("hex");
  const id = await store.addWebhook(parsed.toString(), secret, events);
  // The secret is shown once; delivery signatures cannot be verified without it.
  return reply.code(201).send({ id, events, secret });
});

/**
 * Inbound mail, posted by the transport with the shared secret. The message is
 * parsed here and only its PDF reaches the pipeline — the same quarantine and
 * normalisation the web form gets.
 */
app.post("/hooks/inbound-email", async (request, reply) => {
  if (config.inboundEmailSecret === "") {
    return reply.code(503).send({ error: "email-to-fax is not configured" });
  }
  const provided = Buffer.from(String(request.headers["x-inbound-secret"] ?? ""));
  const expected = Buffer.from(config.inboundEmailSecret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return reply.code(401).send({ error: "bad secret" });
  }

  const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""), "utf8");
  const parsed = parseMessage(raw);
  if (!parsed.ok) {
    return reply.code(400).send({ error: parsed.reason });
  }

  const sender = addressOf(parsed.message.from);
  const account = sender === "" ? null : await db.accountByEmail(sender);
  if (!account) {
    return reply.code(403).send({ error: "the sender is not a fax account" });
  }
  if (!account.enabled) {
    return reply.code(403).send({ error: "the sender's account is disabled" });
  }
  if (!parsed.message.pdf) {
    return reply.code(422).send({ error: "the message carries no PDF attachment" });
  }
  const to = destinationOf(parsed.message.to, parsed.message.subject);
  if (!to) {
    return reply.code(422).send({ error: "no fax number found in the To header or subject" });
  }

  const result = await acceptUpload(uploadPipeline, account.uid, to, {
    stream: Readable.from(parsed.message.pdf),
    filename: parsed.message.attachmentName ?? "email.pdf",
  }).catch((error: unknown) => {
    request.log.error({ err: error }, "inbound fax failed before the pipeline could record it");
    return { ok: false, code: 503, reason: "the fax server could not store the document" } as const;
  });
  if (!result.ok) {
    return reply.code(result.code).send({ error: result.reason });
  }
  emit("fax.queued", {
    jobId: result.jobId,
    hylafaxJob: result.hylafaxJob,
    to,
    pages: result.pages,
    account: account.email,
    source: "email",
  });
  return reply.code(202).send({ ok: true, jobId: result.jobId, hylafaxJob: result.hylafaxJob });
});

app.get("/contacts", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login?next=%2Fcontacts");
  }
  const account = await accountFor(request.identity);
  const contacts = await store.contacts(account.uid);
  const query = request.query as Record<string, unknown>;
  const notice =
    query.added === "1"
      ? { kind: "ok" as const, text: "Contact saved." }
      : query.deleted === "1"
        ? { kind: "ok" as const, text: "Contact deleted." }
        : typeof query.error === "string"
          ? { kind: "error" as const, text: String(query.error).slice(0, 200) }
          : null;
  return reply.type("text/html").send(contactsPage(request.identity, contacts, notice));
});

app.post("/contacts", async (request, reply) => {
  if (!request.identity) {
    return reply.code(401).send({ error: "unauthenticated" });
  }
  const account = await accountFor(request.identity);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const name = String(body.name ?? "").trim().slice(0, 120);
  const number = normaliseFaxNumber(body.number);
  if (name === "" || !number) {
    return reply.redirect(
      `/contacts?error=${encodeURIComponent("a contact needs a name and an E.164 fax number")}`,
    );
  }
  await store.addContact(account.uid, {
    name,
    number,
    email: String(body.email ?? "").trim().slice(0, 190) || null,
    company: String(body.company ?? "").trim().slice(0, 120) || null,
    notes: null,
  });
  return reply.redirect("/contacts?added=1");
});

app.post("/contacts/:id/delete", async (request, reply) => {
  if (!request.identity) {
    return reply.code(401).send({ error: "unauthenticated" });
  }
  const account = await accountFor(request.identity);
  const id = Number.parseInt(String((request.params as Record<string, unknown>).id ?? ""), 10);
  if (Number.isInteger(id) && id > 0) {
    await store.deleteContact(account.uid, id);
  }
  return reply.redirect("/contacts?deleted=1");
});

app.get("/cover-pages", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login?next=%2Fcover-pages");
  }
  const account = await accountFor(request.identity);
  const pages = await store.coverPages(account.uid);
  const query = request.query as Record<string, unknown>;
  const notice =
    query.added === "1"
      ? { kind: "ok" as const, text: "Cover page saved." }
      : query.deleted === "1"
        ? { kind: "ok" as const, text: "Cover page deleted." }
        : typeof query.error === "string"
          ? { kind: "error" as const, text: String(query.error).slice(0, 200) }
          : null;
  return reply.type("text/html").send(coverPagesPage(request.identity, pages, PLACEHOLDERS, notice));
});

app.post("/cover-pages", async (request, reply) => {
  if (!request.identity) {
    return reply.code(401).send({ error: "unauthenticated" });
  }
  const account = await accountFor(request.identity);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const name = String(body.name ?? "").trim().slice(0, 120);
  const template = String(body.body ?? "").slice(0, 4000);
  if (name === "" || template.trim() === "") {
    return reply.redirect(`/cover-pages?error=${encodeURIComponent("a cover page needs a name and a template")}`);
  }
  const unknown = unknownPlaceholders(template);
  if (unknown.length > 0) {
    return reply.redirect(
      `/cover-pages?error=${encodeURIComponent(`unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(", ")}`)}`,
    );
  }
  await store.addCoverPage(account.uid, name, template);
  return reply.redirect("/cover-pages?added=1");
});

app.post("/cover-pages/:id/delete", async (request, reply) => {
  if (!request.identity) {
    return reply.code(401).send({ error: "unauthenticated" });
  }
  const account = await accountFor(request.identity);
  const id = Number.parseInt(String((request.params as Record<string, unknown>).id ?? ""), 10);
  if (Number.isInteger(id) && id > 0) {
    await store.deleteCoverPage(account.uid, id);
  }
  return reply.redirect("/cover-pages?deleted=1");
});

app.get("/outbox", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login?next=%2Foutbox");
  }
  const account = await accountFor(request.identity);
  const entries = await store.outbox(account.uid, account.isAdmin);
  return reply.type("text/html").send(outboxPage(request.identity, entries, account.isAdmin));
});

app.get("/triage", async (request, reply) => {
  if (!request.identity) {
    return reply.redirect("/auth/login?next=%2Ftriage");
  }
  const account = await accountFor(request.identity);
  const rows = await store.triageFor(account.uid, account.isAdmin).catch(() => []);
  const query = request.query as Record<string, unknown>;
  const notice =
    query.updated === "1"
      ? { kind: "ok" as const, text: "Category saved. The original decision is still in the audit trail." }
      : typeof query.error === "string"
        ? { kind: "error" as const, text: String(query.error).slice(0, 200) }
        : null;
  return reply.type("text/html").send(triagePage(request.identity, rows, CATEGORIES, notice));
});

app.post("/triage/:faxid", async (request, reply) => {
  if (!request.identity) {
    return reply.code(401).send({ error: "unauthenticated" });
  }
  const account = await accountFor(request.identity);
  const faxid = Number.parseInt(String((request.params as Record<string, unknown>).faxid ?? ""), 10);
  const body = (request.body ?? {}) as Record<string, unknown>;
  const category = String(body.category ?? "").trim().toLowerCase();
  if (!Number.isInteger(faxid) || faxid <= 0 || !(CATEGORIES as readonly string[]).includes(category)) {
    return reply.redirect(`/triage?error=${encodeURIComponent("unknown fax or category")}`);
  }
  const current = await store.triageFax(faxid, account.isAdmin, account.uid);
  if (!current) {
    return reply.code(404).type("text/html").send(errorPage("Not found", "That fax has no classification for this account."));
  }
  const note = String(body.note ?? "").trim().slice(0, 500) || null;
  await store.overrideTriage(faxid, current.category, category, account.email, note);
  // The human decision replaces what the model filed, and both are recorded.
  await store.clearAutoLabels(faxid);
  await store.fileFaxLabel(faxid, category, "human");
  await store.recordAction(faxid, "override", `${current.category} → ${category}${note ? ` (${note})` : ""}`, account.email);
  await store.recordAction(faxid, "filed", `filed as ${category} by a human`, account.email);
  emit("fax.triaged", { faxid, category, previous: current.category, by: account.email, source: "human" });
  return reply.redirect("/triage?updated=1");
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  for (const loop of loops) {
    clearInterval(loop.timer);
  }
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * Background work. Each loop is guarded by its own in-flight flag so a slow
 * pass (Ghostscript on a large scan) cannot pile up behind the timer, and none
 * of them may take the process down: a queue that cannot be reached is a
 * degraded feature, not a reason to stop answering requests.
 */
interface Loop {
  readonly timer: NodeJS.Timeout;
  readonly tick: () => Promise<void>;
}

function every(label: string, ms: number, task: () => Promise<void>): Loop {
  let busy = false;
  const tick = async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await task();
    } catch (error) {
      app.log.warn({ err: error, loop: label }, "background pass failed");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), ms);
  timer.unref();
  return { timer, tick };
}

/** Text layer first; true OCR only when a binary is configured for it. */
const textExtractors: readonly Extractor[] = [
  {
    name: "pdftotext",
    command: config.hylafax.pdftotextBin,
    args: (path) => ["-q", "-layout", path, "-"],
  },
  ...(config.hylafax.ocrBin === ""
    ? []
    : [
        {
          name: "ocr",
          command: config.hylafax.ocrBin,
          args: (path: string) => ["--skip-text", "--sidecar", "-", "--output-type", "pdf", path, "/dev/null"],
        },
      ]),
];

const loops: Loop[] = [
  every("webhooks", 15_000, async () => {
    await drain({ due: (limit) => store.dueDeliveries(limit), ledger: store });
  }),
  every("delivery", 60_000, async () => {
    const pending = await store.unresolvedJobs();
    if (pending.length === 0) {
      return;
    }
    const queue = await hylafax.queue();
    const byId = new Map(queue.map((job) => [job.jobId, job]));
    for (const job of pending) {
      const state = byId.get(job.hylafaxJob);
      if (!state) {
        continue;
      }
      const outcome = classifyFaxstatState(state.state);
      if (outcome === "sent") {
        await store.updateJob(job.id, "sent");
        emit("fax.sent", { jobId: job.id, hylafaxJob: job.hylafaxJob, to: state.to, pages: state.pages });
      } else if (outcome === "failed") {
        await store.updateJob(job.id, "failed", { detail: state.state.slice(0, 200) });
        emit("fax.failed", { jobId: job.id, hylafaxJob: job.hylafaxJob, to: state.to, reason: state.state });
      }
    }
  }),
  every("spool", 6 * 60 * 60_000, async () => {
    const removed = await pruneSpool(uploadPipeline.spoolDir);
    if (removed > 0) {
      app.log.info({ removed }, "pruned normalised documents older than a day");
    }
  }),
  // Indexing and triage are one pass: a fax that arrives is classified in the
  // same cycle that extracts its text, instead of waiting for the next timer.
  every("intake", 3 * 60_000, async () => {
    const result = await sweep({
      ledger: {
        pending: (limit) => store.pendingText(limit, config.hylafax.archiveDir),
        saveText: (id, body, engine) => store.saveText(id, body, engine),
      },
      run,
      extractors: textExtractors,
    });
    if (result.indexed > 0 || result.empty > 0) {
      app.log.info(result, "archive indexing pass");
    }
    if (!config.triage.enabled) {
      return;
    }
    const triaged = await sweepTriage({
      ledger: store,
      config: config.triage,
      limit: 5,
      onDecision: applyDecision,
    });
    if (triaged.triaged > 0 || triaged.failed > 0) {
      app.log.info(triaged, "triage pass");
    }
  }),
];

// Schema first, then traffic. A failure here leaves the portal answering 503 on
// /healthz instead of starting with tables it cannot use.
try {
  await store.migrate();
} catch (error) {
  app.log.error({ err: error }, "portal schema migration failed; webhooks, jobs and indexing are unavailable");
}

// Run each loop once at boot instead of after the first interval: a freshly
// started portal should index its archive now, not five minutes from now.
for (const loop of loops) {
  void loop.tick();
}

await app.listen({ host: "0.0.0.0", port: config.port });
app.log.info({ origin: config.publicOrigin, issuer: config.issuer, groups: config.allowedGroups }, "fax portal ready");
