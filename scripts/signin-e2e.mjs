#!/usr/bin/env node
/**
 * Browser-driven sign-in test for the portal.
 *
 * Every outage on this path looked fine from curl and only broke in a browser:
 * discovery, PKCE, the code exchange, the group check and the session cookie
 * all have to work in one redirect chain. This drives Chromium through
 * Authentik's login flow with a user it creates for the purpose, asserts the
 * portal let that user in, then deletes the user again.
 *
 *   npm run signin:e2e
 *   node scripts/signin-e2e.mjs --headed --keep-user
 *
 * Credentials, first match wins (same rules as deploy/staging/provision-sso.py):
 *   AUTHENTIK_API_URL / AUTHENTIK_BOOTSTRAP_TOKEN in the environment
 *   AUTHENTIK_ENV_FILE, a dotenv-style file holding them
 *   the estate's `cerulean` container, when this runs on an Incus host
 *
 * Optional:
 *   FAX_E2E_PORTAL     origin to test (default https://fax-staging.lab.innotel.us)
 *   FAX_E2E_GROUP      the group that grants fax access (default Zeus)
 *   FAX_E2E_INSECURE=1 accept an untrusted certificate (self-signed hosts only)
 *   FAX_E2E_DB_URL     mysql://user:pass@host:port/avantfax — where the account
 *                      row the portal provisions on first sign-in is removed
 *
 * The row is removed without `FAX_E2E_DB_URL` too: when the portal under test is
 * the stack in `deploy/staging`, its MariaDB is not published (the portal reaches
 * it over the compose network), so the row is deleted through the db container's
 * own client.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PORTAL = (lookup("FAX_E2E_PORTAL") || "https://fax-staging.lab.innotel.us").replace(/\/+$/, "");
const GROUP = lookup("FAX_E2E_GROUP") || "Zeus";
const HEADED = process.argv.includes("--headed");
const KEEP_USER = process.argv.includes("--keep-user");
const DB_URL = lookup("FAX_E2E_DB_URL");
const STAGING_ENV = fileURLToPath(new URL("../deploy/staging/.env", import.meta.url));
const STAGING_COMPOSE = fileURLToPath(new URL("../deploy/staging/compose.yml", import.meta.url));

function lookup(key) {
  return (process.env[key] ?? "").trim();
}

function fromDotenv(file, key) {
  if (!file || !existsSync(file)) {
    return "";
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = new RegExp(`^${key}=(.+)$`).exec(line.trim());
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

function estateEnv(key) {
  const direct = lookup(key);
  if (direct) {
    return direct;
  }
  const fromFile = fromDotenv(process.env.AUTHENTIK_ENV_FILE, key);
  if (fromFile) {
    return fromFile;
  }
  try {
    const value = execFileSync(
      "incus",
      ["exec", "proxy", "--", "docker", "exec", "cerulean", "printenv", key],
      { encoding: "utf8", timeout: 30_000 },
    ).trim();
    if (value) {
      return value;
    }
  } catch {
    // No estate container on this machine; fall through to the failure below.
  }
  throw new Error(
    `${key} is not set. Export it, point AUTHENTIK_ENV_FILE at a file holding it, ` +
      "or run this on the Incus host that runs the proxy container.",
  );
}

const API = (() => {
  const base = estateEnv("AUTHENTIK_API_URL").replace(/\/+$/, "");
  return base.endsWith("/api/v3") ? base : `${base}/api/v3`;
})();
const AUTHENTIK = API.replace(/\/api\/v3$/, "");
const TOKEN = estateEnv("AUTHENTIK_BOOTSTRAP_TOKEN");

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  return ok;
}

/**
 * One Authentik API call. Transport failures are retried with a growing pause:
 * the estate's hairpin route to the proxy drops a handshake now and then, and a
 * scheduled check that goes red on one lost packet teaches people to ignore it.
 * Four attempts spread over ~14 s clears the usual blip. A rejection from
 * Authentik is not retried — that is a real answer.
 */
const API_ATTEMPTS = 4;

async function api(path, method = "GET", body) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(API + path, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
      }
      return text.trim() === "" ? null : JSON.parse(text);
    } catch (error) {
      if (attempt >= API_ATTEMPTS || !/fetch failed|aborted|timed out|ECONN|EAI_AGAIN/i.test(String(error))) {
        throw error;
      }
      console.error(`retrying ${method} ${path}: ${String(error).slice(0, 160)}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}

/**
 * Create the probe identity. Creating a *new* user every run is deliberate:
 * this must not touch anyone's real account, and a fixed name would collide
 * with the previous run's leftovers.
 */
async function createUser(groupPk) {
  const tag = randomBytes(4).toString("hex");
  const username = `fax-e2e-${tag}`;
  const password = `E2e-${randomBytes(18).toString("base64url")}`;
  const email = `${username}@e2e.invalid`;
  const user = await api("/core/users/", "POST", {
    username,
    name: "Fax portal E2E probe",
    email,
    is_active: true,
    groups: [groupPk],
  });
  await api(`/core/users/${user.pk}/set_password/`, "POST", { password });
  return { pk: user.pk, username, password, email };
}

/**
 * The local staging stack, when the portal under test *is* that stack: its
 * origin and root password come from the stack's own .env, so a probe pointed
 * at another host can never delete a row here. The compose project name gives
 * the container name (`<project>-db-1`).
 */
function localStagingDatabase() {
  const origin = fromDotenv(STAGING_ENV, "FAX_PUBLIC_ORIGIN").replace(/\/+$/, "");
  const password = fromDotenv(STAGING_ENV, "DB_ROOT_PASSWORD");
  if (!origin || origin !== PORTAL || !password || !existsSync(STAGING_COMPOSE)) {
    return null;
  }
  const compose = readFileSync(STAGING_COMPOSE, "utf8");
  const project = /^name:\s*(\S+)$/m.exec(compose)?.[1];
  const database = /MARIADB_DATABASE:\s*(\S+)/.exec(compose)?.[1] ?? "avantfax";
  return project ? { container: `${project}-db-1`, password, database } : null;
}

/**
 * Remove the account row the portal provisions on first sign-in. Returns the
 * number of rows removed, or null when there is no way in from here.
 */
async function deletePortalRow(email) {
  if (DB_URL) {
    const mysql = (await import("mysql2/promise")).default;
    const connection = await mysql.createConnection(DB_URL);
    try {
      const [result] = await connection.execute("DELETE FROM UserAccount WHERE email = ?", [email]);
      return result.affectedRows;
    } finally {
      await connection.end();
    }
  }
  const staging = localStagingDatabase();
  if (!staging) {
    return null;
  }
  // The email is generated here (`<username>@e2e.invalid`), but quote it anyway:
  // this string is SQL, not an argument.
  const quoted = email.replace(/'/g, "''");
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-e",
      `MYSQL_PWD=${staging.password}`,
      staging.container,
      "mariadb",
      "-uroot",
      "-N",
      "-D",
      staging.database,
      "-e",
      `DELETE FROM UserAccount WHERE email = '${quoted}'; SELECT ROW_COUNT();`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return Number(output.trim().split("\n").pop() ?? 0) || 0;
}

/**
 * Delete the probe user and its portal row. `signedIn` guards the database
 * step: a failed run never provisioned anything.
 */
async function cleanup(user, signedIn) {
  if (!user) {
    return;
  }
  if (KEEP_USER) {
    console.log(`kept user ${user.username} (password ${user.password})`);
    return;
  }
  try {
    await api(`/core/users/${user.pk}/`, "DELETE");
    console.log(`deleted Authentik user ${user.username}`);
  } catch (error) {
    console.error(`could not delete Authentik user ${user.username}: ${error.message}`);
  }
  if (!signedIn) {
    return;
  }
  try {
    const removed = await deletePortalRow(user.email);
    if (removed === null) {
      console.log(
        `note: the portal provisioned an account row for ${user.email}; ` +
          "set FAX_E2E_DB_URL (or point it at the staging stack) to have this check remove it",
      );
      return;
    }
    console.log(`deleted ${removed} portal account row(s) for ${user.email}`);
  } catch (error) {
    // The sign-in result is what this check reports on; a leftover row is worth
    // a line, not a failed run.
    console.error(`could not delete the portal row for ${user.email}: ${error.message}`);
  }
}

/**
 * The controls Authentik puts in front of a password login. These live inside
 * the flow's shadow roots — CSS selectors pierce those, descendant XPath does
 * not — and the identification field is `uidField`, camelCase. The light-DOM
 * `input[name="username"]` further down the same page belongs to the
 * no-JavaScript fallback and is hidden; matching it types into nothing, which
 * is why every match here is checked for visibility rather than position.
 */
const STAGES = [
  {
    name: "identification",
    fields: ['input[name="uidField"]', 'input[name="uid_field"]'],
    value: (user) => user.username,
  },
  { name: "password", fields: ['input[name="password"]'], value: (user) => user.password },
];

/** The consent stage lists scopes; its button is the only way forward. */
const CONSENT = ['button[name="consent"]'];
const CONTINUE = ['button[type="submit"]'];

/** First *visible* match across selectors, in order — the flow's DOM is nested. */
async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        return locator.nth(index);
      }
    }
  }
  return null;
}

async function navigate(page, action) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null),
    action,
  ]);
}

async function submit(field) {
  const button = await firstVisible(field.page(), CONTINUE);
  await navigate(field.page(), button ? button.click() : field.press("Enter"));
}

/** Page text Authentik shows when it rejects a step, for the failure report. */
async function stageError(page) {
  const alerts = page.locator('[role="alert"], .pf-c-alert__title, .ak-form-error, .pf-m-danger');
  return (await alerts.allInnerTexts().catch(() => [])).join(" / ").trim();
}

async function signIn(page, user, trace) {
  await page.goto(`${PORTAL}/auth/login?next=/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  trace.push(`start: ${page.url()}`);

  // Authentik renders one stage at a time: identify, password, then consent for
  // a first sign-in. Each is a shadow-DOM form that submits to the next.
  for (let step = 0; step < 12; step += 1) {
    if (page.url().startsWith(PORTAL)) {
      return;
    }
    const deadline = Date.now() + 25_000;
    let acted = false;
    while (!acted && Date.now() < deadline) {
      for (const stage of STAGES) {
        const field = await firstVisible(page, stage.fields);
        if (field) {
          trace.push(`stage: ${stage.name}`);
          await field.fill(stage.value(user));
          await submit(field);
          acted = true;
          break;
        }
      }
      if (acted) {
        break;
      }
      const consent = await firstVisible(page, CONSENT);
      const proceed = consent ?? (await firstVisible(page, CONTINUE));
      if (proceed) {
        trace.push(`stage: ${consent ? "consent" : "continue"}`);
        await navigate(page, proceed.click());
        acted = true;
        break;
      }
      await page.waitForTimeout(200);
    }
    if (!acted) {
      throw new Error(`no sign-in control appeared at ${page.url()}`);
    }
  }
  throw new Error(`sign-in did not return to the portal; stopped at ${page.url()}`);
}

async function main() {
  const group = await api(`/core/groups/?name=${encodeURIComponent(GROUP)}`);
  const groupPk = group.results?.[0]?.pk;
  if (!groupPk) {
    throw new Error(`group "${GROUP}" does not exist in Authentik`);
  }
  check(`group ${GROUP} exists`, true);

  let user = null;
  let provisioned = false;
  const { chromium } = await import("playwright");
  let browser = null;
  try {
    user = await createUser(groupPk);
    console.log(`probe user ${user.username} <${user.email}>`);

    browser = await chromium.launch({ headless: !HEADED, args: ["--no-sandbox"] });
    const context = await browser.newContext({
      ignoreHTTPSErrors: lookup("FAX_E2E_INSECURE") === "1",
    });

    // A visitor with no session must be sent to Authentik, not shown a page.
    // A transport hiccup here is reported and the sign-in attempt still runs:
    // the redirect chain itself exercises the same route.
    try {
      const anonymous = await context.request.get(`${PORTAL}/`, { timeout: 60_000 });
      check(
        "anonymous visitor is redirected to Authentik",
        new URL(anonymous.url()).origin === new URL(AUTHENTIK).origin,
        anonymous.url(),
      );
    } catch (error) {
      check("anonymous visitor is redirected to Authentik", false, String(error).slice(0, 200));
    }

    const page = await context.newPage();
    // A cold proxy can take several seconds to answer; the default 30 s budget
    // is spent on a slow handshake rather than on a broken portal.
    page.setDefaultNavigationTimeout(60_000);
    const trace = [];
    let failure = "";
    try {
      await signIn(page, user, trace);
    } catch (error) {
      failure = error.message;
    }

    const detail = await stageError(page).catch(() => "");
    const body = await page.locator("body").innerText().catch(() => "");
    const heading = (await page.locator("h1").first().textContent().catch(() => "")) ?? "";
    const landed = page.url();

    const arrived = check("sign-in returns to the portal", landed.startsWith(PORTAL), landed);
    const inbox = check("the inbox is served", heading.trim() === "Inbox", heading.trim());
    const identity = check(
      "the inbox is the probe user's",
      body.toLowerCase().includes(user.email.toLowerCase()),
      user.email,
    );
    provisioned = inbox && identity;

    if (!arrived || !inbox || !identity) {
      const cookies = await context.cookies(PORTAL);
      console.error("\n--- sign-in diagnostics ---");
      console.error(`stopped at: ${landed}`);
      for (const line of trace) {
        console.error(`  ${line}`);
      }
      if (detail) {
        console.error(`identity provider said: ${detail}`);
      }
      if (body) {
        console.error(`page said: ${body.replace(/\s+/g, " ").slice(0, 600)}`);
      }
      console.error(`cookies: ${cookies.map((cookie) => cookie.name).join(", ") || "(none)"}`);
      if (failure) {
        console.error(`failure: ${failure}`);
      }
    }

    const session = (await context.cookies(PORTAL)).find((cookie) => cookie.name === "fax_session");
    check("a session cookie was issued", Boolean(session));
    check("the session cookie is httpOnly and secure", Boolean(session?.httpOnly && session?.secure));

    await context.request.get(`${PORTAL}/auth/logout`, { timeout: 30_000, maxRedirects: 0 }).catch(() => null);
    const afterLogout = await context.cookies(PORTAL);
    check("signing out clears the session cookie", !afterLogout.some((cookie) => cookie.name === "fax_session"));

    const failed = checks.filter((entry) => !entry.ok);
    if (failed.length > 0) {
      throw new Error(`${failed.length} of ${checks.length} checks failed`);
    }
    console.log(`\n${checks.length} checks passed against ${PORTAL}`);
  } finally {
    await browser?.close().catch(() => null);
    await cleanup(user, provisioned);
  }
}

main().catch((error) => {
  console.error(`signin-e2e: ${error.message}`);
  process.exitCode = 1;
});
