import { join } from "node:path";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { Config } from "./config.ts";

/**
 * The portal reads and writes the same `avantfax` schema the PHP UI uses, so
 * the two can run side by side during the migration and neither has to be the
 * source of truth twice. Writes go through explicit statements here rather
 * than through the legacy classes, which is what lets the PHP side be removed
 * table by table instead of all at once.
 */
export interface Account {
  readonly uid: number;
  readonly username: string;
  readonly name: string | null;
  readonly email: string;
  readonly isAdmin: boolean;
  readonly enabled: boolean;
}

export interface InboxFax {
  readonly id: number;
  readonly number: string;
  readonly sender: string;
  readonly receivedAt: string;
  readonly pages: number;
  readonly modem: string;
}

export class Database {
  private readonly pool: Pool;

  constructor(config: Config) {
    this.pool = mysql.createPool({
      ...config.database,
      waitForConnections: true,
      connectionLimit: 6,
      namedPlaceholders: false,
      timezone: "Z",
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** The portal-owned tables share this pool; they are separate classes. */
  connectionPool(): Pool {
    return this.pool;
  }

  /** Look up (and on first sight provision) the account for an SSO identity. */
  async accountForIdentity(identity: {
    email: string;
    username: string;
    displayName: string;
    isAdmin: boolean;
  }): Promise<Account> {
    const existing = await this.pool
      .query<RowDataPacket[]>(
        "SELECT uid, username, name, email, is_admin, acc_enabled FROM UserAccount WHERE email = ? LIMIT 1",
        [identity.email],
      )
      .then(([rows]) => rows[0]);

    if (existing) {
      const account = mapAccount(existing);
      if (account.isAdmin !== identity.isAdmin) {
        await this.pool.execute("UPDATE UserAccount SET is_admin = ? WHERE uid = ?", [
          identity.isAdmin ? 1 : 0,
          account.uid,
        ]);
        return { ...account, isAdmin: identity.isAdmin };
      }
      return account;
    }

    const username = await this.uniqueUsername(identity.username || identity.email.split("@")[0] || "faxuser");
    await this.pool.execute(
      `INSERT INTO UserAccount
         (username, name, email, password, pwdcycle, is_admin, acc_enabled, wasreset, language)
       VALUES (?, ?, ?, ?, 0, ?, 1, 0, 'en')`,
      [username, identity.displayName, identity.email, "!sso-only-no-password!", identity.isAdmin ? 1 : 0],
    );

    const created = await this.pool
      .query<RowDataPacket[]>(
        "SELECT uid, username, name, email, is_admin, acc_enabled FROM UserAccount WHERE email = ? LIMIT 1",
        [identity.email],
      )
      .then(([rows]) => rows[0]);
    if (!created) {
      throw new Error(`fax-portal: account for ${identity.email} was not created`);
    }
    return mapAccount(created);
  }

  private async uniqueUsername(candidate: string): Promise<string> {
    const base = candidate.replace(/[^\w.]/g, "").toLowerCase() || "faxuser";
    for (let attempt = 1; attempt < 100; attempt += 1) {
      const name = attempt === 1 ? base : `${base}${attempt}`;
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SELECT uid FROM UserAccount WHERE username = ? LIMIT 1",
        [name],
      );
      if (rows.length === 0) {
        return name;
      }
    }
    throw new Error(`fax-portal: no free username derived from ${candidate}`);
  }

  /** Most recent inbound faxes for one account. */
  async inbox(account: Account, limit = 25): Promise<readonly InboxFax[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT f.faxid, f.faxnumber, f.sender, f.modem, f.pages,
              DATE_FORMAT(COALESCE(f.faxdate, f.faxstamp), '%Y-%m-%dT%H:%i:%sZ') AS received
         FROM FaxArchive f
        WHERE f.uid = ? AND f.archived = 0
        ORDER BY COALESCE(f.faxdate, f.faxstamp) DESC
        LIMIT ?`,
      [account.uid, limit],
    );
    return rows.map((row) => ({
      id: Number(row.faxid),
      number: String(row.faxnumber ?? ""),
      sender: String(row.sender ?? ""),
      modem: String(row.modem ?? ""),
      pages: Number(row.pages ?? 0),
      receivedAt: String(row.received ?? ""),
    }));
  }

  /** Resolve an account by SSO email, without provisioning one. */
  async accountByEmail(email: string): Promise<Account | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT uid, username, name, email, is_admin, acc_enabled FROM UserAccount WHERE email = ? LIMIT 1",
      [email.trim().toLowerCase()],
    );
    const row = rows[0];
    return row ? mapAccount(row) : null;
  }

  /**
   * The stored PDF for one archived fax, scoped to the caller. Returns null when
   * the fax belongs to someone else — an ownership check, not an error, so the
   * route can answer 404 without leaking which ids exist.
   */
  async faxFile(id: number, account: Account, archiveDir: string): Promise<{ path: string; name: string } | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT faxfname FROM FaxArchive WHERE faxid = ? AND (uid = ? OR ? = 1) LIMIT 1",
      [id, account.uid, account.isAdmin ? 1 : 0],
    );
    const row = rows[0];
    const name = row ? String(row.faxfname ?? "") : "";
    if (name === "") {
      return null;
    }
    // The filename comes from the database, not from the request, so it cannot
    // traverse out of the archive directory.
    return { path: join(archiveDir, name), name };
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}

function mapAccount(row: RowDataPacket): Account {
  return {
    uid: Number(row.uid),
    username: String(row.username ?? ""),
    name: row.name === null ? null : String(row.name),
    email: String(row.email ?? ""),
    isAdmin: Number(row.is_admin ?? 0) === 1,
    enabled: Number(row.acc_enabled ?? 0) === 1,
  };
}
