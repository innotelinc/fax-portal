/**
 * Configuration is read once at boot and validated. A portal that starts with a
 * half-configured OIDC client is worse than one that refuses to start: the
 * failure would surface later as "login is broken" instead of a deploy error.
 */
export interface Config {
  readonly port: number;
  readonly publicOrigin: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowedGroups: readonly string[];
  readonly adminGroups: readonly string[];
  readonly sessionSecret: string;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
  };
  readonly hylafax: {
    readonly binDir: string;
    readonly spoolDir: string;
    readonly callerId: string;
    /** Where AvantFAX keeps the received PDFs, served by the viewer. */
    readonly archiveDir: string;
    /** Private staging area for uploads; never inside the HylaFAX spool. */
    readonly quarantineDir: string;
    readonly ghostscriptBin: string;
    readonly pdftotextBin: string;
    /** Optional OCR pass for scanned faxes, e.g. /usr/bin/ocrmypdf. */
    readonly ocrBin: string;
  };
  /** Shared secret the mail transport presents on the inbound-email hook. */
  readonly inboundEmailSecret: string;
  /**
   * Optional fax triage. With no API key the feature is off: the portal never
   * sends customer documents to a third party it has not been told to use.
   */
  readonly triage: {
    readonly enabled: boolean;
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly provider: string;
    readonly minConfidence: number;
    readonly maxChars: number;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = (env[key] ?? "").trim();
  if (value === "") {
    throw new Error(`fax-portal: ${key} is required`);
  }
  return value;
}

function clamp(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function list(value: string): readonly string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionSecret = required(env, "FAX_SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("fax-portal: FAX_SESSION_SECRET must be at least 32 characters");
  }

  const allowedGroups = list(env.FAX_ALLOWED_GROUPS ?? "Zeus,Capstone");
  if (allowedGroups.length === 0) {
    throw new Error("fax-portal: FAX_ALLOWED_GROUPS must name at least one group");
  }

  return {
    port: Number.parseInt(env.PORT ?? "3000", 10),
    publicOrigin: required(env, "FAX_PUBLIC_ORIGIN").replace(/\/+$/, ""),
    issuer: required(env, "FAX_OIDC_ISSUER").replace(/\/+$/, ""),
    clientId: required(env, "FAX_OIDC_CLIENT_ID"),
    clientSecret: required(env, "FAX_OIDC_CLIENT_SECRET"),
    allowedGroups,
    adminGroups: list(env.FAX_ADMIN_GROUPS ?? "cerulean-platform"),
    sessionSecret,
    database: {
      host: env.FAX_DB_HOST ?? "127.0.0.1",
      port: Number.parseInt(env.FAX_DB_PORT ?? "3306", 10),
      user: env.FAX_DB_USER ?? "avantfax",
      password: required(env, "FAX_DB_PASSWORD"),
      database: env.FAX_DB_NAME ?? "avantfax",
    },
    hylafax: {
      binDir: env.FAX_HYLAFAX_BIN ?? "/usr/sbin",
      spoolDir: env.FAX_HYLAFAX_SPOOL ?? "/var/spool/hylafax",
      callerId: env.FAX_CALLER_ID ?? "fax@innotel.us",
      archiveDir: env.FAX_ARCHIVE_DIR ?? "/var/www/avantfax/faxes",
      quarantineDir: env.FAX_QUARANTINE_DIR ?? "/var/lib/fax-portal/quarantine",
      ghostscriptBin: env.FAX_GHOSTSCRIPT_BIN ?? "/usr/bin/gs",
      pdftotextBin: env.FAX_PDFTOTEXT_BIN ?? "/usr/bin/pdftotext",
      ocrBin: env.FAX_OCR_BIN ?? "",
    },
    inboundEmailSecret: env.FAX_INBOUND_EMAIL_SECRET ?? "",
    triage: {
      enabled: (env.FAX_TRIAGE_API_KEY ?? "").trim() !== "",
      baseUrl: (env.FAX_TRIAGE_BASE_URL ?? "https://api.z.ai/v1").replace(/\/+$/, ""),
      apiKey: (env.FAX_TRIAGE_API_KEY ?? "").trim(),
      model: env.FAX_TRIAGE_MODEL ?? "kilo-gateway/kilo-auto/free",
      provider: env.FAX_TRIAGE_PROVIDER ?? "openai-compatible",
      minConfidence: clamp(env.FAX_TRIAGE_MIN_CONFIDENCE, 0, 1, 0.75),
      maxChars: Math.round(clamp(env.FAX_TRIAGE_MAX_CHARS, 500, 20_000, 6000)),
    },
  };
}
