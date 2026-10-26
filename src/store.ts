import { join } from "node:path";
import type { Pool } from "mysql2/promise";
import type { PendingFax } from "./ocr.ts";

/**
 * Portal-owned tables.
 *
 * They live in the same `avantfax` database as the legacy schema but are never
 * written by the PHP app, so the migration can drop one without touching the
 * other. Every statement here is idempotent: `migrate()` runs at boot.
 */
export type JobStatus = "quarantined" | "normalising" | "queued" | "sent" | "failed";

export interface JobRecord {
  readonly id: number;
  readonly accountUid: number;
  readonly to: string;
  readonly status: JobStatus;
  readonly hylafaxJob: string | null;
  readonly detail: string | null;
  readonly pages: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface Contact {
  readonly id: number;
  readonly name: string;
  readonly number: string;
  readonly email: string | null;
  readonly company: string | null;
  readonly notes: string | null;
}

export interface CoverPage {
  readonly id: number;
  readonly name: string;
  readonly body: string;
  /** Organisation-wide templates belong to an administrator. */
  readonly shared: boolean;
}

export interface OutboxEntry {
  readonly id: number;
  readonly accountUid: number;
  readonly to: string;
  readonly status: JobStatus;
  readonly hylafaxJob: string | null;
  readonly pages: number;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface TriageCandidate {
  readonly faxid: number;
  readonly text: string;
}

export type TriageStatus = "auto" | "needs_review" | "reviewed" | "failed";

export interface TriageRow {
  readonly faxid: number;
  readonly category: string;
  readonly counterparty: string;
  readonly confidence: number;
  readonly status: TriageStatus;
  readonly model: string;
  readonly createdAt: string;
  readonly number: string;
  readonly sender: string;
  readonly ownerUid: number;
}

export interface TriageDecision {
  readonly faxid: number;
  readonly category: string;
  readonly counterparty: string;
  readonly confidence: number;
  readonly status: TriageStatus;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputSha256: string;
  readonly outputJson: string;
}

export interface AdminAccount {
  readonly uid: number;
  readonly username: string;
  readonly name: string | null;
  readonly email: string;
  readonly isAdmin: boolean;
  readonly enabled: boolean;
}

export interface LineRow {
  readonly id: number;
  readonly number: string;
  readonly label: string;
  readonly accountUid: number | null;
  readonly accountEmail: string | null;
  readonly enabled: boolean;
}

export interface AuditRow {
  readonly actor: string;
  readonly action: string;
  readonly subject: string;
  readonly detail: string;
  readonly at: string;
}

export interface TriageActionRow {
  readonly action: string;
  readonly detail: string;
  readonly actor: string;
  readonly at: string;
}

export interface TriageOverrideRow {
  readonly from: string;
  readonly to: string;
  readonly by: string;
  readonly note: string | null;
  readonly at: string;
}

export interface WebhookTarget {
  readonly id: number;
  readonly url: string;
  readonly secret: string;
  readonly events: readonly string[];
}

export interface PendingDelivery {
  readonly id: number;
  readonly webhookId: number;
  readonly url: string;
  readonly secret: string;
  readonly event: string;
  readonly payload: string;
  readonly attempts: number;
}

export class PortalStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS PortalJob (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         account_uid INT NOT NULL,
         to_number VARCHAR(32) NOT NULL,
         status ENUM('quarantined','normalising','queued','sent','failed') NOT NULL,
         hylafax_job VARCHAR(32) NULL,
         pages INT NOT NULL DEFAULT 0,
         sha256 CHAR(64) NOT NULL,
         detail VARCHAR(255) NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY account_created (account_uid, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalFaxText (
         faxid INT PRIMARY KEY,
         body LONGTEXT NOT NULL,
         engine VARCHAR(32) NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FULLTEXT KEY body_ft (body)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalContact (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         account_uid INT NOT NULL,
         name VARCHAR(120) NOT NULL,
         number VARCHAR(32) NOT NULL,
         email VARCHAR(190) NULL,
         company VARCHAR(120) NULL,
         notes VARCHAR(500) NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY account_name (account_uid, name)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalCoverPage (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         account_uid INT NULL,
         name VARCHAR(120) NOT NULL,
         body TEXT NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY account_name (account_uid, name)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalTriage (
         faxid INT PRIMARY KEY,
         category VARCHAR(32) NOT NULL,
         counterparty VARCHAR(190) NOT NULL DEFAULT '',
         confidence DECIMAL(4,3) NOT NULL,
         status ENUM('auto','needs_review','reviewed','failed') NOT NULL,
         provider VARCHAR(64) NOT NULL,
         model VARCHAR(64) NOT NULL,
         prompt_version VARCHAR(16) NOT NULL,
         input_sha256 CHAR(64) NOT NULL,
         output_json TEXT NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY status_created (status, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalLine (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         number VARCHAR(32) NOT NULL UNIQUE,
         label VARCHAR(120) NOT NULL DEFAULT '',
         account_uid INT NULL,
         enabled TINYINT(1) NOT NULL DEFAULT 1,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY account (account_uid)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalAudit (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         actor_email VARCHAR(190) NOT NULL,
         action VARCHAR(64) NOT NULL,
         subject VARCHAR(190) NOT NULL,
         detail VARCHAR(255) NOT NULL DEFAULT '',
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY created (created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalFaxLabel (
         faxid INT NOT NULL,
         label VARCHAR(32) NOT NULL,
         source ENUM('auto','human') NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (faxid, label),
         KEY label (label)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalTriageAction (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         faxid INT NOT NULL,
         action VARCHAR(32) NOT NULL,
         detail VARCHAR(255) NOT NULL DEFAULT '',
         actor VARCHAR(190) NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY faxid_created (faxid, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalTriageOverride (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         faxid INT NOT NULL,
         from_category VARCHAR(32) NOT NULL,
         to_category VARCHAR(32) NOT NULL,
         by_email VARCHAR(190) NOT NULL,
         note VARCHAR(500) NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY faxid (faxid)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalWebhook (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         url VARCHAR(512) NOT NULL,
         secret VARCHAR(128) NOT NULL,
         events VARCHAR(255) NOT NULL,
         enabled TINYINT(1) NOT NULL DEFAULT 1,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS PortalWebhookDelivery (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         webhook_id BIGINT NOT NULL,
         event VARCHAR(64) NOT NULL,
         payload TEXT NOT NULL,
         attempts INT NOT NULL DEFAULT 0,
         next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         delivered_at TIMESTAMP NULL,
         last_error VARCHAR(255) NULL,
         KEY due (delivered_at, next_attempt_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
    for (const sql of statements) {
      await this.pool.query(sql);
    }
    // Widen the enum on databases created by an earlier build, where 'sent'
    // did not exist yet. Idempotent, so it runs on every boot.
    await this.pool.query(
      "ALTER TABLE PortalJob MODIFY COLUMN status ENUM('quarantined','normalising','queued','sent','failed') NOT NULL",
    );
  }

  async createJob(job: {
    accountUid: number;
    to: string;
    sha256: string;
  }): Promise<number> {
    const [result] = await this.pool.execute(
      "INSERT INTO PortalJob (account_uid, to_number, status, sha256) VALUES (?, ?, 'quarantined', ?)",
      [job.accountUid, job.to, job.sha256],
    );
    return Number((result as { insertId: number }).insertId);
  }

  async updateJob(
    id: number,
    status: JobStatus,
    patch: { hylafaxJob?: string; detail?: string; pages?: number } = {},
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE PortalJob
          SET status = ?, hylafax_job = COALESCE(?, hylafax_job), detail = COALESCE(?, detail),
              pages = COALESCE(?, pages)
        WHERE id = ?`,
      [status, patch.hylafaxJob ?? null, patch.detail ?? null, patch.pages ?? null, id],
    );
  }

  async jobForAccount(id: number, accountUid: number): Promise<JobRecord | null> {
    const [rows] = await this.pool.query(
      `SELECT id, account_uid, to_number, status, hylafax_job, detail, pages, sha256, created_at
         FROM PortalJob WHERE id = ? AND account_uid = ? LIMIT 1`,
      [id, accountUid],
    );
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) {
      return null;
    }
    return {
      id: Number(row.id),
      accountUid: Number(row.account_uid),
      to: String(row.to_number),
      status: String(row.status) as JobStatus,
      hylafaxJob: row.hylafax_job === null ? null : String(row.hylafax_job),
      detail: row.detail === null ? null : String(row.detail),
      pages: Number(row.pages ?? 0),
      sha256: String(row.sha256),
      createdAt: String(row.created_at),
    };
  }

  /**
   * How many faxes carry extracted text, scoped to the caller: a client must not
   * learn how much fax traffic the estate handles.
   */
  async countText(accountUid: number, includeAll: boolean): Promise<number> {
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS n
         FROM PortalFaxText t
         JOIN FaxArchive f ON f.faxid = t.faxid
        WHERE t.body <> '' ${includeAll ? "" : "AND f.uid = ?"}`,
      includeAll ? [] : [accountUid],
    );
    return Number((rows as Record<string, unknown>[])[0]?.n ?? 0);
  }

  /** HylaFAX request ids this account submitted, for filtering the queue. */
  async hylafaxJobsForAccount(accountUid: number): Promise<readonly string[]> {
    const [rows] = await this.pool.query(
      "SELECT hylafax_job FROM PortalJob WHERE account_uid = ? AND hylafax_job IS NOT NULL",
      [accountUid],
    );
    return (rows as Record<string, unknown>[]).map((row) => String(row.hylafax_job));
  }

  /** Queued jobs whose delivery state has not been resolved yet. */
  async unresolvedJobs(): Promise<readonly { id: number; hylafaxJob: string }[]> {
    const [rows] = await this.pool.query(
      "SELECT id, hylafax_job FROM PortalJob WHERE status = 'queued' AND hylafax_job IS NOT NULL",
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      hylafaxJob: String(row.hylafax_job),
    }));
  }

  /** Archived faxes with no extracted text yet, for the OCR sweep. */
  async pendingText(limit: number, archiveDir: string): Promise<readonly PendingFax[]> {
    const [rows] = await this.pool.query(
      `SELECT f.faxid, f.faxfname
         FROM FaxArchive f
         LEFT JOIN PortalFaxText t ON t.faxid = f.faxid
        WHERE t.faxid IS NULL AND f.faxfname IS NOT NULL AND f.faxfname <> ''
        ORDER BY f.faxid DESC
        LIMIT ?`,
      [limit],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.faxid),
      path: join(archiveDir, String(row.faxfname)),
    }));
  }

  async saveText(faxid: number, body: string, engine: string): Promise<void> {
    await this.pool.execute(
      `INSERT INTO PortalFaxText (faxid, body, engine) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE body = VALUES(body), engine = VALUES(engine)`,
      [faxid, body.slice(0, 16 * 1024 * 1024), engine],
    );
  }

  /** Full-text search, scoped to what the caller is allowed to see. */
  async search(accountUid: number, includeAll: boolean, query: string, limit = 25) {
    const [rows] = await this.pool.query(
      `SELECT f.faxid, f.faxnumber, f.sender, f.modem,
              DATE_FORMAT(COALESCE(f.faxdate, f.faxstamp), '%Y-%m-%dT%H:%i:%sZ') AS received,
              SUBSTRING(t.body, 1, 240) AS excerpt
         FROM PortalFaxText t
         JOIN FaxArchive f ON f.faxid = t.faxid
        WHERE MATCH(t.body) AGAINST (? IN NATURAL LANGUAGE MODE)
          ${includeAll ? "" : "AND f.uid = ?"}
        ORDER BY f.faxid DESC
        LIMIT ?`,
      includeAll ? [query, limit] : [query, accountUid, limit],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.faxid),
      number: String(row.faxnumber ?? ""),
      sender: String(row.sender ?? ""),
      modem: String(row.modem ?? ""),
      receivedAt: String(row.received ?? ""),
      excerpt: String(row.excerpt ?? ""),
    }));
  }

  async addWebhook(url: string, secret: string, events: readonly string[]): Promise<number> {
    const [result] = await this.pool.execute(
      "INSERT INTO PortalWebhook (url, secret, events) VALUES (?, ?, ?)",
      [url, secret, events.join(",")],
    );
    return Number((result as { insertId: number }).insertId);
  }

  async deleteWebhook(id: number): Promise<boolean> {
    // Pending deliveries go with it: an endpoint that no longer exists must not
    // keep receiving retries for a day.
    await this.pool.execute("DELETE FROM PortalWebhookDelivery WHERE webhook_id = ?", [id]);
    const [result] = await this.pool.execute("DELETE FROM PortalWebhook WHERE id = ?", [id]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }

  async webhooks(): Promise<readonly WebhookTarget[]> {
    const [rows] = await this.pool.query("SELECT id, url, secret, events FROM PortalWebhook WHERE enabled = 1");
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      url: String(row.url),
      secret: String(row.secret),
      events: String(row.events).split(",").filter(Boolean),
    }));
  }

  /** Queue a delivery for every endpoint subscribed to this event. */
  async enqueueEvent(event: string, payload: unknown): Promise<number> {
    const targets = (await this.webhooks()).filter((hook) => hook.events.includes(event));
    for (const hook of targets) {
      await this.pool.execute(
        "INSERT INTO PortalWebhookDelivery (webhook_id, event, payload) VALUES (?, ?, ?)",
        [hook.id, event, JSON.stringify(payload)],
      );
    }
    return targets.length;
  }

  async dueDeliveries(limit = 20): Promise<readonly PendingDelivery[]> {
    const [rows] = await this.pool.query(
      `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret
         FROM PortalWebhookDelivery d
         JOIN PortalWebhook w ON w.id = d.webhook_id
        WHERE d.delivered_at IS NULL AND d.next_attempt_at <= UTC_TIMESTAMP()
          AND w.enabled = 1
        ORDER BY d.id
        LIMIT ?`,
      [limit],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      webhookId: Number(row.webhook_id),
      url: String(row.url),
      secret: String(row.secret),
      event: String(row.event),
      payload: String(row.payload),
      attempts: Number(row.attempts),
    }));
  }

  async markDelivered(id: number): Promise<void> {
    await this.pool.execute("UPDATE PortalWebhookDelivery SET delivered_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  }

  async markDeliveryFailed(id: number, attempts: number, error: string): Promise<void> {
    // Exponential backoff capped at an hour; 8 attempts ≈ a day of retrying.
    const delay = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
    await this.pool.execute(
      `UPDATE PortalWebhookDelivery
          SET attempts = ?, last_error = ?,
              next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
              delivered_at = IF(? >= 8, UTC_TIMESTAMP(), delivered_at)
        WHERE id = ?`,
      [attempts, error.slice(0, 255), delay, attempts, id],
    );
  }

  // ---- contacts -----------------------------------------------------------

  async contacts(accountUid: number): Promise<readonly Contact[]> {
    const [rows] = await this.pool.query(
      `SELECT id, name, number, email, company, notes
         FROM PortalContact WHERE account_uid = ? ORDER BY name`,
      [accountUid],
    );
    return (rows as Record<string, unknown>[]).map(mapContact);
  }

  async addContact(accountUid: number, contact: Omit<Contact, "id">): Promise<number> {
    const [result] = await this.pool.execute(
      "INSERT INTO PortalContact (account_uid, name, number, email, company, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [accountUid, contact.name, contact.number, contact.email, contact.company, contact.notes],
    );
    return Number((result as { insertId: number }).insertId);
  }

  async deleteContact(accountUid: number, id: number): Promise<boolean> {
    const [result] = await this.pool.execute("DELETE FROM PortalContact WHERE id = ? AND account_uid = ?", [
      id,
      accountUid,
    ]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }

  // ---- cover pages --------------------------------------------------------

  /** The account's own templates plus the organisation-wide ones. */
  async coverPages(accountUid: number): Promise<readonly CoverPage[]> {
    const [rows] = await this.pool.query(
      `SELECT id, account_uid, name, body FROM PortalCoverPage
        WHERE account_uid = ? OR account_uid IS NULL ORDER BY name`,
      [accountUid],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      body: String(row.body),
      shared: row.account_uid === null,
    }));
  }

  async coverPage(accountUid: number, id: number): Promise<CoverPage | null> {
    const [rows] = await this.pool.query(
      `SELECT id, account_uid, name, body FROM PortalCoverPage
        WHERE id = ? AND (account_uid = ? OR account_uid IS NULL) LIMIT 1`,
      [id, accountUid],
    );
    const row = (rows as Record<string, unknown>[])[0];
    return row ? { id: Number(row.id), name: String(row.name), body: String(row.body), shared: row.account_uid === null } : null;
  }

  async addCoverPage(accountUid: number | null, name: string, body: string): Promise<number> {
    const [result] = await this.pool.execute("INSERT INTO PortalCoverPage (account_uid, name, body) VALUES (?, ?, ?)", [
      accountUid,
      name,
      body,
    ]);
    return Number((result as { insertId: number }).insertId);
  }

  async deleteCoverPage(accountUid: number, id: number): Promise<boolean> {
    const [result] = await this.pool.execute("DELETE FROM PortalCoverPage WHERE id = ? AND account_uid = ?", [
      id,
      accountUid,
    ]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }

  // ---- outbox -------------------------------------------------------------

  /** The account's sends, newest first, with their delivery state. */
  async outbox(accountUid: number, includeAll: boolean, limit = 50): Promise<readonly OutboxEntry[]> {
    const [rows] = await this.pool.query(
      `SELECT id, account_uid, to_number, status, hylafax_job, pages, detail,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created
         FROM PortalJob
        ${includeAll ? "" : "WHERE account_uid = ?"}
        ORDER BY id DESC LIMIT ?`,
      includeAll ? [limit] : [accountUid, limit],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      accountUid: Number(row.account_uid),
      to: String(row.to_number),
      status: String(row.status) as JobStatus,
      hylafaxJob: row.hylafax_job === null ? null : String(row.hylafax_job),
      pages: Number(row.pages ?? 0),
      detail: row.detail === null ? null : String(row.detail),
      createdAt: String(row.created),
    }));
  }

  // ---- triage -------------------------------------------------------------

  /** Archived faxes with text that have never been triaged. */
  async pendingTriage(limit: number): Promise<readonly TriageCandidate[]> {
    const [rows] = await this.pool.query(
      `SELECT f.faxid, t.body
         FROM PortalFaxText t
         JOIN FaxArchive f ON f.faxid = t.faxid
         LEFT JOIN PortalTriage g ON g.faxid = t.faxid
        WHERE g.faxid IS NULL AND CHAR_LENGTH(t.body) >= 40
        ORDER BY f.faxid DESC
        LIMIT ?`,
      [limit],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      faxid: Number(row.faxid),
      text: String(row.body),
    }));
  }

  /** Triage results for the caller's faxes (or everything, for an administrator). */
  async triageFor(
    accountUid: number,
    includeAll: boolean,
    limit = 50,
  ): Promise<readonly TriageRow[]> {
    const [rows] = await this.pool.query(
      `SELECT g.faxid, g.category, g.counterparty, g.confidence, g.status, g.model,
              g.created_at, f.faxnumber, f.sender, f.uid
         FROM PortalTriage g
         JOIN FaxArchive f ON f.faxid = g.faxid
        ${includeAll ? "" : "WHERE f.uid = ?"}
        ORDER BY g.status = 'needs_review' DESC, g.faxid DESC
        LIMIT ?`,
      includeAll ? [limit] : [accountUid, limit],
    );
    return (rows as Record<string, unknown>[]).map(mapTriageRow);
  }

  async triageFax(faxid: number, includeAll: boolean, accountUid: number): Promise<TriageRow | null> {
    const [rows] = await this.pool.query(
      `SELECT g.faxid, g.category, g.counterparty, g.confidence, g.status, g.model,
              g.created_at, f.faxnumber, f.sender, f.uid
         FROM PortalTriage g
         JOIN FaxArchive f ON f.faxid = g.faxid
        WHERE g.faxid = ? ${includeAll ? "" : "AND f.uid = ?"} LIMIT 1`,
      includeAll ? [faxid] : [faxid, accountUid],
    );
    const row = (rows as Record<string, unknown>[])[0];
    return row ? mapTriageRow(row) : null;
  }

  async saveTriage(decision: TriageDecision): Promise<void> {
    await this.pool.execute(
      `INSERT INTO PortalTriage
         (faxid, category, counterparty, confidence, status, provider, model, prompt_version, input_sha256, output_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE category = VALUES(category), counterparty = VALUES(counterparty),
         confidence = VALUES(confidence), status = VALUES(status), model = VALUES(model),
         prompt_version = VALUES(prompt_version), input_sha256 = VALUES(input_sha256),
         output_json = VALUES(output_json)`,
      [
        decision.faxid,
        decision.category,
        decision.counterparty.slice(0, 190),
        decision.confidence,
        decision.status,
        decision.provider,
        decision.model,
        decision.promptVersion,
        decision.inputSha256,
        decision.outputJson.slice(0, 64 * 1024),
      ],
    );
  }

  /**
   * A human changing an automated decision. The override is appended, never
   * overwriting the original classification, so the audit trail keeps both.
   */
  async overrideTriage(
    faxid: number,
    currentCategory: string,
    toCategory: string,
    byEmail: string,
    note: string | null,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO PortalTriageOverride (faxid, from_category, to_category, by_email, note)
       VALUES (?, ?, ?, ?, ?)`,
      [faxid, currentCategory, toCategory, byEmail, note],
    );
    await this.pool.execute("UPDATE PortalTriage SET category = ?, status = 'reviewed' WHERE faxid = ?", [
      toCategory,
      faxid,
    ]);
  }

  /** File a fax under a label. Filing twice is a no-op, not a duplicate. */
  async fileFaxLabel(faxid: number, label: string, source: "auto" | "human"): Promise<void> {
    await this.pool.execute(
      "INSERT IGNORE INTO PortalFaxLabel (faxid, label, source) VALUES (?, ?, ?)",
      [faxid, label.slice(0, 32), source],
    );
  }

  /** A human decision replaces the automatic filing, it does not stack on it. */
  async clearAutoLabels(faxid: number): Promise<void> {
    await this.pool.execute("DELETE FROM PortalFaxLabel WHERE faxid = ? AND source = 'auto'", [faxid]);
  }

  /** Append-only record of everything done to a fax on a model's say-so. */
  async recordAction(faxid: number, action: string, detail: string, actor: string): Promise<void> {
    await this.pool.execute(
      "INSERT INTO PortalTriageAction (faxid, action, detail, actor) VALUES (?, ?, ?, ?)",
      [faxid, action.slice(0, 32), detail.slice(0, 255), actor.slice(0, 190)],
    );
  }

  async actionsFor(faxid: number): Promise<readonly TriageActionRow[]> {
    const [rows] = await this.pool.query(
      `SELECT action, detail, actor, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created
         FROM PortalTriageAction WHERE faxid = ? ORDER BY id`,
      [faxid],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      action: String(row.action),
      detail: String(row.detail),
      actor: String(row.actor),
      at: String(row.created),
    }));
  }

  /** Labels per fax, for the inbox and search listings. */
  async labelsForAccount(accountUid: number, includeAll: boolean): Promise<ReadonlyMap<number, string>> {
    const [rows] = await this.pool.query(
      `SELECT l.faxid, MAX(l.label) AS label
         FROM PortalFaxLabel l
         JOIN FaxArchive f ON f.faxid = l.faxid
        ${includeAll ? "" : "WHERE f.uid = ?"}
        GROUP BY l.faxid`,
      includeAll ? [] : [accountUid],
    );
    return new Map(
      (rows as Record<string, unknown>[]).map((row) => [Number(row.faxid), String(row.label)] as const),
    );
  }

  // ---- admin: accounts, lines, audit --------------------------------------

  async accounts(): Promise<readonly AdminAccount[]> {
    const [rows] = await this.pool.query(
      "SELECT uid, username, name, email, is_admin, acc_enabled FROM UserAccount ORDER BY username",
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      uid: Number(row.uid),
      username: String(row.username),
      name: row.name === null ? null : String(row.name),
      email: String(row.email),
      isAdmin: Number(row.is_admin) === 1,
      enabled: Number(row.acc_enabled) === 1,
    }));
  }

  async setAccountEnabled(uid: number, enabled: boolean): Promise<void> {
    await this.pool.execute("UPDATE UserAccount SET acc_enabled = ? WHERE uid = ?", [enabled ? 1 : 0, uid]);
  }

  async setAccountAdmin(uid: number, admin: boolean): Promise<void> {
    await this.pool.execute("UPDATE UserAccount SET is_admin = ? WHERE uid = ?", [admin ? 1 : 0, uid]);
  }

  async lines(): Promise<readonly LineRow[]> {
    const [rows] = await this.pool.query(
      `SELECT l.id, l.number, l.label, l.account_uid, l.enabled, u.email
         FROM PortalLine l
         LEFT JOIN UserAccount u ON u.uid = l.account_uid
        ORDER BY l.number`,
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      number: String(row.number),
      label: String(row.label ?? ""),
      accountUid: row.account_uid === null ? null : Number(row.account_uid),
      accountEmail: row.email === null ? null : String(row.email),
      enabled: Number(row.enabled) === 1,
    }));
  }

  async addLine(number: string, label: string, accountUid: number | null): Promise<number> {
    const [result] = await this.pool.execute(
      "INSERT INTO PortalLine (number, label, account_uid) VALUES (?, ?, ?)",
      [number, label, accountUid],
    );
    return Number((result as { insertId: number }).insertId);
  }

  async deleteLine(id: number): Promise<boolean> {
    const [result] = await this.pool.execute("DELETE FROM PortalLine WHERE id = ?", [id]);
    return (result as { affectedRows: number }).affectedRows > 0;
  }

  async assignLine(id: number, accountUid: number | null): Promise<void> {
    await this.pool.execute("UPDATE PortalLine SET account_uid = ? WHERE id = ?", [accountUid, id]);
  }

  async setLineEnabled(id: number, enabled: boolean): Promise<void> {
    await this.pool.execute("UPDATE PortalLine SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  /** Append-only: every administrative change names who made it. */
  async audit(actor: string, action: string, subject: string, detail: string): Promise<void> {
    await this.pool.execute(
      "INSERT INTO PortalAudit (actor_email, action, subject, detail) VALUES (?, ?, ?, ?)",
      [actor.slice(0, 190), action.slice(0, 64), subject.slice(0, 190), detail.slice(0, 255)],
    );
  }

  async auditRows(limit = 50): Promise<readonly AuditRow[]> {
    const [rows] = await this.pool.query(
      `SELECT actor_email, action, subject, detail,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created
         FROM PortalAudit ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      actor: String(row.actor_email),
      action: String(row.action),
      subject: String(row.subject),
      detail: String(row.detail),
      at: String(row.created),
    }));
  }

  async overrides(faxid: number): Promise<readonly TriageOverrideRow[]> {
    const [rows] = await this.pool.query(
      `SELECT from_category, to_category, by_email, note,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created
         FROM PortalTriageOverride WHERE faxid = ? ORDER BY id`,
      [faxid],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      from: String(row.from_category),
      to: String(row.to_category),
      by: String(row.by_email),
      note: row.note === null ? null : String(row.note),
      at: String(row.created),
    }));
  }
}

function mapContact(row: Record<string, unknown>): Contact {
  return {
    id: Number(row.id),
    name: String(row.name),
    number: String(row.number),
    email: row.email === null ? null : String(row.email),
    company: row.company === null ? null : String(row.company),
    notes: row.notes === null ? null : String(row.notes),
  };
}

function mapTriageRow(row: Record<string, unknown>): TriageRow {
  return {
    faxid: Number(row.faxid),
    category: String(row.category),
    counterparty: String(row.counterparty ?? ""),
    confidence: Number(row.confidence),
    status: String(row.status) as TriageStatus,
    model: String(row.model),
    createdAt: String(row.created_at),
    number: String(row.faxnumber ?? ""),
    sender: String(row.sender ?? ""),
    ownerUid: Number(row.uid),
  };
}
