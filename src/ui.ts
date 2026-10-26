import type { Identity } from "./auth.ts";
import type { InboxFax, Account } from "./db.ts";
import type { QueuedJob } from "./hylafax.ts";
import type { AdminAccount, AuditRow, Contact, CoverPage, LineRow, OutboxEntry, TriageRow } from "./store.ts";

/** Server-rendered HTML: no client bundle, no hydration, nothing to break. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root{--ink:#0b1220;--muted:#5b6b84;--line:#e3e8ef;--bg:#f7f9fc;--surface:#fff;
--brand:#0e7490;--brand-dark:#155e75;--radius:14px;
--shadow:0 1px 2px rgba(11,18,32,.05),0 14px 32px rgba(11,18,32,.07)}
@media (prefers-color-scheme:dark){:root{--ink:#e6edf6;--muted:#93a4bb;--line:#25324a;
--bg:#0b1220;--surface:#121a29;--brand:#22b8d4;--brand-dark:#5ad3e8;
--shadow:0 1px 2px rgba(0,0,0,.4),0 16px 36px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);min-height:100vh;display:flex;flex-direction:column;
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif}
a{color:var(--brand);text-decoration:none}a:hover{color:var(--brand-dark)}
.wrap{width:100%;max-width:1080px;margin:0 auto;padding:0 24px}
header.top{position:sticky;top:0;z-index:10;background:var(--surface);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;gap:14px;min-height:62px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700}
.brand .mark{width:31px;height:31px;border-radius:9px;display:grid;place-items:center;color:#fff;
background:linear-gradient(135deg,var(--brand),#0891b2);font-size:11px}
.brand small{display:block;font-weight:500;font-size:11.5px;color:var(--muted)}
nav{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chip{padding:6px 12px;border-radius:999px;border:1px solid var(--line);font-size:13px;color:var(--muted)}
.chip b{color:var(--ink)}
.btn{display:inline-flex;align-items:center;gap:8px;padding:9px 15px;border-radius:10px;font-weight:650;
font-size:14px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
.btn:hover{border-color:var(--brand);color:var(--brand)}
.btn.primary{background:var(--brand);border-color:transparent;color:#fff}
.btn.primary:hover{background:var(--brand-dark);color:#fff}
main{flex:1;padding:36px 0 56px}
h1{font-size:clamp(24px,3vw,34px);letter-spacing:-.025em;margin:0 0 8px}
.lede{color:var(--muted);margin:0 0 28px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
box-shadow:var(--shadow);overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th{text-align:left;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);
padding:11px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
td{padding:12px 16px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
tr:hover td{background:var(--bg)}
.empty{padding:28px 16px;color:var(--muted);text-align:center}
form.send{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;
background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:26px}
label{display:block;font-size:12px;font-weight:650;color:var(--muted);margin-bottom:6px}
input[type=text],input[type=file]{width:100%;padding:10px 12px;border:1px solid var(--line);
border-radius:9px;background:var(--bg);color:var(--ink);font:inherit}
footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:13px}
footer.site .wrap{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:20px 24px}
.notice{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;
color:var(--muted);margin:0 0 20px}
@media(max-width:760px){form.send{grid-template-columns:1fr}}
select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;
background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:120px;resize:vertical}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:650}
.tag.ok{background:rgba(14,116,144,.12);color:var(--brand)}
.tag.warn{background:rgba(194,65,12,.14);color:#c2410c}
.tag.bad{background:rgba(153,27,27,.14);color:#b91c1c}
.row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn.small{padding:5px 10px;font-size:12.5px;border-radius:8px}
.btn.danger:hover{border-color:#b91c1c;color:#b91c1c}
`;

function shell(title: string, identity: Identity | null, body: string): string {
  const nav = identity
    ? `<a class="chip" href="/">Inbox</a>
       <a class="chip" href="/outbox">Outbox</a>
       <a class="chip" href="/contacts">Contacts</a>
       <a class="chip" href="/cover-pages">Cover pages</a>
       <a class="chip" href="/triage">Review</a>
       <span class="chip">${identity.isAdmin ? "Administrator" : "Client"} · <b>${escapeHtml(identity.displayName)}</b></span>
       ${identity.isAdmin ? '<a class="btn" href="/admin">Admin console</a>' : ""}
       <a class="btn" href="/auth/logout">Sign out</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Innotel Fax</title>
<meta name="theme-color" content="#0e7490">
<style>${STYLE}</style></head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/"><span class="mark">FAX</span><span>Innotel Fax<small>Fax portal</small></span></a>
  <nav>${nav}</nav>
</div></header>
<main><div class="wrap">${body}</div></main>
<footer class="site"><div class="wrap"><span>© ${new Date().getFullYear()} Innotel · Fax plane</span>
<span>${identity ? escapeHtml(identity.email) : "Signed in with your Innotel account"}</span></div></footer>
</body></html>`;
}

export function inboxPage(
  identity: Identity,
  account: Account,
  faxes: readonly InboxFax[],
  jobs: readonly QueuedJob[],
  notice?: { readonly kind: "ok" | "error"; readonly text: string } | null,
  compose: {
    readonly contacts: readonly Contact[];
    readonly coverPages: readonly CoverPage[];
    readonly prefillTo?: string;
    readonly labels?: ReadonlyMap<number, string>;
  } = { contacts: [], coverPages: [] },
): string {
  const rows = faxes
    .map(
      (fax) => `<tr>
        <td>${escapeHtml(fax.receivedAt.replace("T", " ").replace("Z", ""))}</td>
        <td>${escapeHtml(fax.sender || fax.number)}${
          compose.labels?.get(fax.id) ? ` ${tag("ok", String(compose.labels.get(fax.id)))}` : ""
        }</td>
        <td>${fax.pages} page${fax.pages === 1 ? "" : "s"}</td>
        <td>${escapeHtml(fax.modem)}</td>
        <td><a href="/fax/${fax.id}">Open</a></td>
      </tr>`,
    )
    .join("");
  const jobRows = jobs
    .map(
      (job) => `<tr><td>#${escapeHtml(job.jobId)}</td><td>${escapeHtml(job.to)}</td>
        <td>${escapeHtml(job.state)}</td><td>${job.pages}</td></tr>`,
    )
    .join("");

  const body = `
  <h1>Inbox</h1>
  <p class="lede">Signed in as ${escapeHtml(identity.email)} — fax that arrived for this account.</p>
  ${
    notice
      ? `<p class="notice" role="status" style="border-left:3px solid ${notice.kind === "ok" ? "var(--brand)" : "#c2410c"}">${escapeHtml(notice.text)}</p>`
      : ""
  }

  <form class="send" method="get" action="/search" style="grid-template-columns:1fr auto">
    <div><label for="q">Search the archive</label>
      <input id="q" name="q" type="text" placeholder="invoice, account number, name in the document"></div>
    <button class="btn" type="submit">Search</button>
  </form>

  <form class="send" method="post" action="/fax/send" enctype="multipart/form-data">
    <div><label for="to">Send to</label>
      <input id="to" name="to" type="text" inputmode="tel" placeholder="+15551234567" list="contact-numbers" value="${escapeHtml(
        compose.prefillTo ?? "",
      )}" required>
      <datalist id="contact-numbers">${compose.contacts
        .map((contact) => `<option value="${escapeHtml(contact.number)}">${escapeHtml(contact.name)}</option>`)
        .join("")}</datalist></div>
    <div><label for="coverPageId">Cover page</label>
      <select id="coverPageId" name="coverPageId">
        <option value="">No cover page</option>
        ${compose.coverPages.map((page) => `<option value="${page.id}">${escapeHtml(page.name)}</option>`).join("")}
      </select></div>
    <div><label for="document">PDF document</label>
      <input id="document" name="document" type="file" accept="application/pdf" required></div>
    <button class="btn primary" type="submit">Send fax</button>
  </form>

  <div class="panel">
    <table>
      <thead><tr><th>Received</th><th>From</th><th>Pages</th><th>Line</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="5">No fax yet.</td></tr>'}</tbody>
    </table>
  </div>

  <h2 style="margin:34px 0 12px;font-size:18px">Sending queue</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Job</th><th>To</th><th>State</th><th>Pages</th></tr></thead>
      <tbody>${jobRows || '<tr><td class="empty" colspan="4">Nothing queued.</td></tr>'}</tbody>
    </table>
  </div>`;
  return shell("Inbox", identity, body);
}

export interface SearchHit {
  readonly id: number;
  readonly number: string;
  readonly sender: string;
  readonly receivedAt: string;
  readonly excerpt: string;
}

export function searchPage(
  identity: Identity,
  query: string,
  hits: readonly SearchHit[],
  indexed: number,
): string {
  const rows = hits
    .map(
      (hit) => `<tr>
        <td>${escapeHtml(hit.receivedAt.replace("T", " ").replace("Z", ""))}</td>
        <td>${escapeHtml(hit.sender || hit.number)}</td>
        <td>${escapeHtml(hit.excerpt.slice(0, 200))}</td>
        <td><a href="/fax/${hit.id}">Open</a></td>
      </tr>`,
    )
    .join("");

  const body = `
  <h1>Archive search</h1>
  <p class="lede">${indexed} fax${indexed === 1 ? "" : "es"} indexed. Results are limited to fax addressed to this account.</p>
  <form class="send" method="get" action="/search" style="grid-template-columns:1fr auto">
    <div><label for="q">Search text</label>
      <input id="q" name="q" type="text" value="${escapeHtml(query)}" required></div>
    <button class="btn primary" type="submit">Search</button>
  </form>
  <div class="panel">
    <table>
      <thead><tr><th>Received</th><th>From</th><th>Match</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td class="empty" colspan="4">No fax matches ${escapeHtml(query || "this search")}.</td></tr>`}</tbody>
    </table>
  </div>
  <p style="margin:18px 0 0"><a class="btn" href="/">Back to the inbox</a></p>`;
  return shell("Search", identity, body);
}

function tag(kind: "ok" | "warn" | "bad", text: string): string {
  return `<span class="tag ${kind}">${escapeHtml(text)}</span>`;
}

const NOTICE_STYLE = (notice: { kind: "ok" | "error"; text: string }) =>
  `<p class="notice" role="status" style="border-left:3px solid ${notice.kind === "ok" ? "var(--brand)" : "#c2410c"}">${escapeHtml(notice.text)}</p>`;

export function contactsPage(
  identity: Identity,
  contacts: readonly Contact[],
  notice: { kind: "ok" | "error"; text: string } | null = null,
): string {
  const rows = contacts
    .map(
      (contact) => `<tr>
        <td><b>${escapeHtml(contact.name)}</b>${contact.company ? `<br><small style="color:var(--muted)">${escapeHtml(contact.company)}</small>` : ""}</td>
        <td>${escapeHtml(contact.number)}</td>
        <td>${contact.email ? escapeHtml(contact.email) : "—"}</td>
        <td class="row-actions">
          <a class="btn small" href="/?to=${encodeURIComponent(contact.number)}">Send</a>
          <form method="post" action="/contacts/${contact.id}/delete">
            <button class="btn small danger" type="submit">Delete</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  const body = `
  <h1>Contacts</h1>
  <p class="lede">Numbers you fax often. Private to this account.</p>
  ${notice ? NOTICE_STYLE(notice) : ""}
  <form class="send" method="post" action="/contacts" style="grid-template-columns:2fr 2fr 2fr auto">
    <div><label for="name">Name</label><input id="name" name="name" type="text" maxlength="120" required></div>
    <div><label for="number">Fax number</label><input id="number" name="number" type="text" inputmode="tel" placeholder="+15551234567" required></div>
    <div><label for="company">Company (optional)</label><input id="company" name="company" type="text" maxlength="120"></div>
    <button class="btn primary" type="submit">Add</button>
  </form>
  <div class="panel">
    <table>
      <thead><tr><th>Name</th><th>Fax</th><th>Email</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="4">No contacts yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  return shell("Contacts", identity, body);
}

export function coverPagesPage(
  identity: Identity,
  pages: readonly CoverPage[],
  placeholders: readonly string[],
  notice: { kind: "ok" | "error"; text: string } | null = null,
): string {
  const rows = pages
    .map(
      (page) => `<tr>
        <td><b>${escapeHtml(page.name)}</b>${page.shared ? ` ${tag("ok", "shared")}` : ""}</td>
        <td><pre style="margin:0;white-space:pre-wrap;font:inherit;color:var(--muted);max-width:52ch">${escapeHtml(
          page.body.slice(0, 240),
        )}</pre></td>
        <td>${page.shared ? "—" : `<form method="post" action="/cover-pages/${page.id}/delete"><button class="btn small danger" type="submit">Delete</button></form>`}</td>
      </tr>`,
    )
    .join("");

  const body = `
  <h1>Cover pages</h1>
  <p class="lede">A cover page is rendered for the fax it is attached to. Placeholders: ${placeholders
    .map((name) => `<code>{{${escapeHtml(name)}}}</code>`)
    .join(" ")}.</p>
  ${notice ? NOTICE_STYLE(notice) : ""}
  <form method="post" action="/cover-pages" style="background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:26px">
    <label for="cp-name">Name</label>
    <input id="cp-name" name="name" type="text" maxlength="120" placeholder="Invoice cover" required>
    <div style="margin-top:12px"><label for="cp-body">Template</label>
      <textarea id="cp-body" name="body" maxlength="4000" required>To: {{to}}
From: {{from}}
Date: {{date}}
Pages: {{pages}}

Please find the attached fax.</textarea></div>
    <div style="margin-top:12px"><button class="btn primary" type="submit">Save cover page</button></div>
  </form>
  <div class="panel">
    <table>
      <thead><tr><th>Name</th><th>Template</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="3">No cover pages yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  return shell("Cover pages", identity, body);
}

const JOB_TAG: Record<string, "ok" | "warn" | "bad"> = {
  queued: "warn",
  sent: "ok",
  failed: "bad",
  normalising: "warn",
  quarantined: "warn",
};

export function outboxPage(identity: Identity, entries: readonly OutboxEntry[], includeAll: boolean): string {
  const rows = entries
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.createdAt.replace("T", " ").replace("Z", ""))}</td>
        <td>${escapeHtml(entry.to)}</td>
        <td>${entry.pages} page${entry.pages === 1 ? "" : "s"}</td>
        <td>${tag(JOB_TAG[entry.status] ?? "warn", entry.status)}</td>
        <td>${entry.hylafaxJob ? escapeHtml(entry.hylafaxJob) : "—"}</td>
        <td>${entry.detail ? escapeHtml(entry.detail.slice(0, 120)) : "—"}</td>
      </tr>`,
    )
    .join("");

  const body = `
  <h1>Outbox</h1>
  <p class="lede">${includeAll ? "Every fax submitted through the portal." : "Fax you submitted through the portal, newest first."}</p>
  <div class="panel">
    <table>
      <thead><tr><th>Queued</th><th>To</th><th>Pages</th><th>State</th><th>Job</th><th>Detail</th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="6">Nothing sent yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  return shell("Outbox", identity, body);
}

export function triagePage(
  identity: Identity,
  rows: readonly TriageRow[],
  categories: readonly string[],
  notice: { kind: "ok" | "error"; text: string } | null = null,
): string {
  const tableRows = rows
    .map((row) => {
      const state =
        row.status === "auto"
          ? tag("ok", "auto")
          : row.status === "reviewed"
            ? tag("ok", "reviewed")
            : row.status === "failed"
              ? tag("bad", "failed")
              : tag("warn", "needs review");
      return `<tr>
        <td>${escapeHtml(row.createdAt.replace("T", " ").replace("Z", ""))}</td>
        <td>${escapeHtml(row.sender || row.number)}</td>
        <td><b>${escapeHtml(row.category)}</b> ${state}<br><small style="color:var(--muted)">${Math.round(
          row.confidence * 100,
        )}% · ${escapeHtml(row.counterparty || "no counterparty")}</small></td>
        <td><a href="/fax/${row.faxid}">Open</a></td>
        <td>
          <form method="post" action="/triage/${row.faxid}" class="row-actions">
            <select name="category" aria-label="Category">
              ${categories
                .map((category) => `<option value="${escapeHtml(category)}"${category === row.category ? " selected" : ""}>${escapeHtml(category)}</option>`)
                .join("")}
            </select>
            <input name="note" type="text" maxlength="200" placeholder="why (optional)" style="max-width:16ch">
            <button class="btn small" type="submit">Save</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `
  <h1>Review</h1>
  <p class="lede">Automatic classification of incoming fax. Anything marked “needs review” is a decision the model was not sure enough to make; changing a category records who did it and why.</p>
  ${notice ? NOTICE_STYLE(notice) : ""}
  <div class="panel">
    <table>
      <thead><tr><th>Triaged</th><th>From</th><th>Category</th><th>Fax</th><th>Override</th></tr></thead>
      <tbody>${tableRows || '<tr><td class="empty" colspan="5">Nothing triaged yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  return shell("Review", identity, body);
}

export function adminPage(
  identity: Identity,
  counts: { accounts: number; lines: number; audits: readonly AuditRow[] },
): string {
  const auditRows = counts.audits
    .map(
      (row) => `<tr><td>${escapeHtml(row.at.replace("T", " ").replace("Z", ""))}</td>
        <td>${escapeHtml(row.actor)}</td><td>${escapeHtml(row.action)}</td>
        <td>${escapeHtml(row.subject)}</td><td>${escapeHtml(row.detail)}</td></tr>`,
    )
    .join("");

  const body = `
  <h1>Admin console</h1>
  <p class="lede">Accounts, lines and routing for the fax server. Every change here is written to the audit trail below.</p>
  <div class="panel" style="margin-bottom:24px">
    <table>
      <thead><tr><th>Surface</th><th>What it holds</th><th></th></tr></thead>
      <tbody>
        <tr><td><b>Accounts</b></td><td>${counts.accounts} account${counts.accounts === 1 ? "" : "s"} — enable, disable, grant administrator</td><td><a class="btn small" href="/admin/accounts">Open</a></td></tr>
        <tr><td><b>Lines</b></td><td>${counts.lines} DID line${counts.lines === 1 ? "" : "s"} — assign a line to the account that receives its fax</td><td><a class="btn small" href="/admin/lines">Open</a></td></tr>
        <tr><td><b>Webhooks</b></td><td>Signed delivery endpoints (JSON)</td><td><a class="btn small" href="/admin/webhooks">Open</a></td></tr>
      </tbody>
    </table>
  </div>
  <h2 style="margin:0 0 12px;font-size:18px">Recent changes</h2>
  <div class="panel">
    <table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th><th>Detail</th></tr></thead>
      <tbody>${auditRows || '<tr><td class="empty" colspan="5">No administrative changes yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  return shell("Admin", identity, body);
}

export function adminAccountsPage(
  identity: Identity,
  accounts: readonly AdminAccount[],
  selfUid: number,
  notice: { kind: "ok" | "error"; text: string } | null = null,
): string {
  const rows = accounts
    .map((account) => {
      const state = account.enabled ? tag("ok", "enabled") : tag("bad", "disabled");
      const role = account.isAdmin ? tag("ok", "administrator") : tag("warn", "client");
      const action = (label: string, path: string, danger = false) =>
        `<form method="post" action="/admin/accounts/${account.uid}/${path}">
           <button class="btn small${danger ? " danger" : ""}" type="submit">${label}</button></form>`;
      return `<tr>
        <td><b>${escapeHtml(account.username)}</b>${account.uid === selfUid ? ' <small style="color:var(--muted)">(you)</small>' : ""}</td>
        <td>${escapeHtml(account.email)}</td>
        <td>${state} ${role}</td>
        <td class="row-actions">
          ${account.enabled ? action("Disable", "disable", true) : action("Enable", "enable")}
          ${account.isAdmin ? action("Revoke admin", "revoke-admin", true) : action("Make admin", "grant-admin")}
        </td>
      </tr>`;
    })
    .join("");

  const body = `
  <h1>Accounts</h1>
  <p class="lede">A disabled account cannot sign in to the portal; its fax archive stays where it is.</p>
  ${notice ? NOTICE_STYLE(notice) : ""}
  <div class="panel">
    <table>
      <thead><tr><th>Account</th><th>Email</th><th>State</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="4">No accounts yet.</td></tr>'}</tbody>
    </table>
  </div>
  <p style="margin-top:18px"><a class="btn" href="/admin">Back to the console</a></p>`;
  return shell("Accounts", identity, body);
}

export function adminLinesPage(
  identity: Identity,
  lines: readonly LineRow[],
  accounts: readonly AdminAccount[],
  notice: { kind: "ok" | "error"; text: string } | null = null,
): string {
  const accountOptions = (selected: number | null) =>
    `<option value=""${selected === null ? " selected" : ""}>Unassigned</option>` +
    accounts
      .map(
        (account) =>
          `<option value="${account.uid}"${selected === account.uid ? " selected" : ""}>${escapeHtml(account.email)}</option>`,
      )
      .join("");

  const rows = lines
    .map(
      (line) => `<tr>
        <td><b>${escapeHtml(line.number)}</b><br><small style="color:var(--muted)">${escapeHtml(line.label || "no label")}</small></td>
        <td>${line.enabled ? tag("ok", "in service") : tag("bad", "disabled")}</td>
        <td>
          <form method="post" action="/admin/lines/${line.id}/assign" class="row-actions">
            <select name="accountUid" aria-label="Receiving account">${accountOptions(line.accountUid)}</select>
            <button class="btn small" type="submit">Assign</button>
          </form>
        </td>
        <td class="row-actions">
          <form method="post" action="/admin/lines/${line.id}/${line.enabled ? "disable" : "enable"}">
            <button class="btn small" type="submit">${line.enabled ? "Disable" : "Enable"}</button></form>
          <form method="post" action="/admin/lines/${line.id}/delete">
            <button class="btn small danger" type="submit">Delete</button></form>
        </td>
      </tr>`,
    )
    .join("");

  const body = `
  <h1>Lines</h1>
  <p class="lede">DID numbers the fax server answers, and the account each one routes to. Applied by the portal once it owns reception (last migration phase); until then AvantFAX still assigns the owner of an arriving fax, so treat this as the routing table being prepared, not the live one.</p>
  ${notice ? NOTICE_STYLE(notice) : ""}
  <form class="send" method="post" action="/admin/lines" style="grid-template-columns:2fr 2fr 2fr auto">
    <div><label for="line-number">Number</label><input id="line-number" name="number" type="text" inputmode="tel" placeholder="+15551230001" required></div>
    <div><label for="line-label">Label</label><input id="line-label" name="label" type="text" maxlength="120" placeholder="Main office"></div>
    <div><label for="line-account">Receives to</label><select id="line-account" name="accountUid">${accountOptions(null)}</select></div>
    <button class="btn primary" type="submit">Add line</button>
  </form>
  <div class="panel">
    <table>
      <thead><tr><th>Line</th><th>State</th><th>Routes to</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td class="empty" colspan="4">No lines configured.</td></tr>'}</tbody>
    </table>
  </div>
  <p style="margin-top:18px"><a class="btn" href="/admin">Back to the console</a></p>`;
  return shell("Lines", identity, body);
}

export function deniedPage(title: string, message: string, identity: Identity | null): string {
  return shell(
    title,
    identity,
    `<h1>${escapeHtml(title)}</h1><p class="notice">${escapeHtml(message)}</p>
     <a class="btn primary" href="/">Back to the portal</a>`,
  );
}

export function errorPage(title: string, detail: string): string {
  return shell(
    title,
    null,
    `<h1>${escapeHtml(title)}</h1><p class="notice">${escapeHtml(detail)}</p>
     <a class="btn primary" href="/auth/login">Try signing in again</a>`,
  );
}
