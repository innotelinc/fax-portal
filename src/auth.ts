import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT, createLocalJWKSet, errors as joseErrors, type JSONWebKeySet } from "jose";
import type { Config } from "./config.ts";

/**
 * Authorization-code + PKCE against the estate's Authentik, with the same
 * subscription gate the current gateway enforces: an identity is admitted only
 * if it holds one of the configured product groups. The session is a signed,
 * httpOnly cookie holding nothing but the identity and its role — no token is
 * stored server-side, so the portal can be scaled out without a session store.
 */
export interface Identity {
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly groups: readonly string[];
  readonly isAdmin: boolean;
}

export interface PendingLogin {
  readonly state: string;
  readonly verifier: string;
  readonly redirectTo: string;
}

const SESSION_COOKIE = "fax_session";
const PENDING_COOKIE = "fax_login";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** The parts of an OIDC discovery document this client relies on. */
interface ProviderMetadata {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
}

export class Auth {
  private metadata: Promise<ProviderMetadata> | null = null;
  private reachability: { readonly at: number; readonly ok: boolean; readonly detail: string } | null = null;
  private keys: { readonly set: ReturnType<typeof createLocalJWKSet>; readonly fetchedAt: number } | null = null;

  /**
   * Endpoints come from the provider's discovery document, not from the issuer
   * URL. Authentik (and most providers) serve authorize/token from a shared
   * path while the issuer is per application: guessing `/authorize/` from the
   * issuer yields a 404 that looks exactly like a broken client.
   */
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Can the browser be sent somewhere that answers? Reported by /healthz so a
   * portal that cannot reach its issuer is visible before the first login
   * attempt, instead of looking healthy until somebody clicks sign-in. The
   * answer is cached briefly: health checks run every fifteen seconds and the
   * issuer does not deserve that much attention.
   */
  async reachable(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    const now = Date.now();
    if (this.reachability !== null && now - this.reachability.at < 60_000) {
      return { ok: this.reachability.ok, detail: this.reachability.detail };
    }
    try {
      await this.provider();
      this.reachability = { at: now, ok: true, detail: "" };
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
      this.reachability = { at: now, ok: false, detail };
    }
    return { ok: this.reachability.ok, detail: this.reachability.detail };
  }

  private provider(): Promise<ProviderMetadata> {
    if (this.metadata === null) {
      const pending = (async (): Promise<ProviderMetadata> => {
        const response = await this.fetchImpl(`${this.config.issuer}/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(`oidc discovery failed: HTTP ${response.status}`);
        }
        const document = (await response.json()) as Partial<ProviderMetadata>;
        for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
          if (typeof document[key] !== "string" || document[key] === "") {
            throw new Error(`oidc discovery document has no ${key}`);
          }
        }
        return document as ProviderMetadata;
      })();
      this.metadata = pending;
      // A failed discovery must not be cached forever: the next request retries.
      pending.catch(() => {
        this.metadata = null;
      });
    }
    return this.metadata;
  }

  get cookieName(): string {
    return SESSION_COOKIE;
  }

  get pendingCookieName(): string {
    return PENDING_COOKIE;
  }

  /** Where the browser is sent to authenticate, plus the state we must verify. */
  async begin(redirectTo: string): Promise<{ readonly url: string; readonly pending: PendingLogin }> {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const metadata = await this.provider();
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl());
    url.searchParams.set("scope", "openid email profile groups");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    return { url: url.toString(), pending: { state, verifier, redirectTo } };
  }

  callbackUrl(): string {
    return `${this.config.publicOrigin}/auth/callback`;
  }

  /**
   * Verify an identity token against the provider's published keys.
   *
   * The key set is cached for ten minutes and refetched once when a token names
   * a key we do not hold — that is what key rotation looks like from here: the
   * provider signs with a new kid, verification fails to find it, and the next
   * attempt uses the refreshed set.
   *
   * The issuer is matched exactly, but once with a trailing slash and once
   * without: Authentik publishes `…/application/o/<slug>/` in its discovery
   * document and in client-credentials tokens, yet id tokens from the
   * authorization-code flow have been seen both with and without it. Both are
   * the configured issuer; neither is a wildcard, so a foreign issuer fails.
   *
   * The spellings are rebuilt from a normalised base rather than appended to
   * the configured value: `loadConfig` already strips the trailing slash, so
   * deriving one spelling from the other produced a single candidate and the
   * fallback silently never ran.
   */
  private async verifyIdToken(token: string, metadata: ProviderMetadata) {
    const verify = async (force: boolean, issuer: string) => {
      const set = await this.keySet(metadata, force);
      return jwtVerify(token, set, { issuer, audience: this.config.clientId });
    };
    const base = this.config.issuer.replace(/\/+$/, "");
    const issuers = base === "" ? [this.config.issuer] : [base, `${base}/`];

    /** Try each accepted spelling; only an issuer disagreement moves on. */
    const verifyAny = async (force: boolean) => {
      let last: unknown = null;
      for (const issuer of issuers) {
        try {
          return await verify(force, issuer);
        } catch (error) {
          last = error;
          if (!(error instanceof joseErrors.JWTClaimValidationFailed) || error.claim !== "iss") {
            throw error;
          }
        }
      }
      throw last ?? new Error("no issuer to verify against");
    };

    try {
      return await verifyAny(false);
    } catch (error) {
      // A key we do not hold is rotation, not rejection: refetch and try again
      // against every spelling, not just the one that missed.
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        try {
          return await verifyAny(true);
        } catch (retry) {
          throw withClaims(retry, token, issuers);
        }
      }
      throw withClaims(error, token, issuers);
    }
  }

  private async keySet(metadata: ProviderMetadata, force: boolean) {
    const fresh = 10 * 60 * 1000;
    if (!force && this.keys && Date.now() - this.keys.fetchedAt < fresh) {
      return this.keys.set;
    }
    const response = await this.fetchImpl(metadata.jwks_uri, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`oidc key fetch failed: HTTP ${response.status}`);
    }
    const document = (await response.json()) as JSONWebKeySet;
    if (!Array.isArray(document.keys) || document.keys.length === 0) {
      throw new Error("oidc key set is empty");
    }
    const set = createLocalJWKSet(document);
    this.keys = { set, fetchedAt: Date.now() };
    return set;
  }

  /**
   * POST the code to the token endpoint, retrying once on a transport failure.
   *
   * A connection that never carried the grant says nothing about the code: the
   * provider never read it, so the same exchange can be repeated without
   * double-spending it. One retry covers the case that actually bit staging —
   * a pooled connection the reverse proxy closed while idle, which undici
   * reuses and which fails in tens of milliseconds. A provider *rejection* is
   * never retried; only an unanswered request is.
   */
  private async exchange(endpoint: string, body: URLSearchParams): Promise<Response> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      try {
        return await this.fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        last = error;
      }
    }
    // No answer at all is not the provider saying no. Saying it is sends the
    // next person looking for a broken client when the network cannot reach
    // the issuer — which is how the staging sign-in failure was misread. The
    // cause chain carries the errno, which is what says *why* it failed.
    throw new ProviderUnreachable(describeFetchFailure(last));
  }

  /** Exchange the code and verify the identity token against the provider JWKS. */
  async complete(code: string, pending: PendingLogin): Promise<Identity> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callbackUrl(),
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: pending.verifier,
    });

    const metadata = await this.provider();
    const response = await this.exchange(metadata.token_endpoint, body);
    if (!response.ok) {
      throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
    }

    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token) {
      throw new Error("token exchange returned no id_token");
    }

    let claims: Record<string, unknown>;
    try {
      const verified = await this.verifyIdToken(tokens.id_token, metadata);
      claims = verified.payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) {
        throw new Error(`id_token rejected: ${error.message}`);
      }
      throw error;
    }

    const email = String(claims.email ?? "").toLowerCase();
    if (email === "") {
      throw new Error("id_token carries no email claim");
    }

    const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
    const admitted = groups.some((group) =>
      this.config.allowedGroups.some((allowed) => allowed.toLowerCase() === group.toLowerCase()),
    );
    if (!admitted) {
      throw new NotSubscribed(email, groups);
    }

    return {
      email,
      username: String(claims.preferred_username ?? email.split("@")[0] ?? "faxuser"),
      displayName: String(claims.name ?? claims.preferred_username ?? email.split("@")[0] ?? "Operator"),
      groups,
      isAdmin: groups.some((group) =>
        this.config.adminGroups.some((allowed) => allowed.toLowerCase() === group.toLowerCase()),
      ),
    };
  }

  async issueSession(identity: Identity): Promise<string> {
    return new SignJWT({
      email: identity.email,
      username: identity.username,
      name: identity.displayName,
      groups: identity.groups,
      admin: identity.isAdmin,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setIssuer("innotel-fax-portal")
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(new TextEncoder().encode(this.config.sessionSecret));
  }

  async readSession(token: string | undefined): Promise<Identity | null> {
    if (!token) {
      return null;
    }
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(this.config.sessionSecret), {
        issuer: "innotel-fax-portal",
      });
      const email = String(payload.email ?? "");
      if (email === "") {
        return null;
      }
      return {
        email,
        username: String(payload.username ?? ""),
        displayName: String(payload.name ?? ""),
        groups: Array.isArray(payload.groups) ? payload.groups.map(String) : [],
        isAdmin: payload.admin === true,
      };
    } catch {
      return null;
    }
  }

  signPending(pending: PendingLogin): Promise<string> {
    return new SignJWT({ ...pending })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(this.config.sessionSecret));
  }

  async readPending(token: string | undefined): Promise<PendingLogin | null> {
    if (!token) {
      return null;
    }
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(this.config.sessionSecret));
      return {
        state: String(payload.state ?? ""),
        verifier: String(payload.verifier ?? ""),
        redirectTo: String(payload.redirectTo ?? "/"),
      };
    } catch {
      return null;
    }
  }

  get sessionTtlSeconds(): number {
    return SESSION_TTL_SECONDS;
  }

  async logoutUrl(): Promise<string> {
    let endpoint: string;
    try {
      const metadata = await this.provider();
      endpoint = metadata.end_session_endpoint ?? `${this.config.issuer}/end-session/`;
    } catch {
      // Signing out must work even when the provider is unreachable.
      endpoint = `${this.config.issuer}/end-session/`;
    }
    const url = new URL(endpoint);
    url.searchParams.set("post_logout_redirect_uri", this.config.publicOrigin);
    return url.toString();
  }
}

/** Read a token's claims without trusting them, for error messages only. */
function readClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * A rejected token says nothing useful on its own: "unexpected iss claim value"
 * hides both sides of the mismatch. The claims are reported, never trusted, and
 * only for rejections — a transport failure keeps its own message.
 */
function withClaims(error: unknown, token: string, expected: readonly string[]): unknown {
  if (!(error instanceof joseErrors.JOSEError)) {
    return error;
  }
  const claims = readClaims(token);
  const seen = { iss: claims.iss ?? null, aud: claims.aud ?? null, expected };
  return new Error(`id_token rejected: ${error.message} — unverified claims ${JSON.stringify(seen)}`);
}

/** Follow a fetch failure's cause chain down to the errno that explains it. */
function describeFetchFailure(error: unknown): string {
  const parts: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < 4 && node instanceof Error; depth += 1) {
    const detail = node as Error & { code?: string; errno?: number; address?: string; port?: number };
    const where = detail.address ? ` ${detail.address}${detail.port ? `:${detail.port}` : ""}` : "";
    parts.push(`${detail.code ? `${detail.code} ` : ""}${detail.message}${where}`.trim());
    node = (detail as { cause?: unknown }).cause;
  }
  const text = parts.filter((part) => part !== "").join(" <- ");
  return (text === "" ? String(error) : text).slice(0, 300);
}

/** Raised when the token endpoint could not be reached at all. */
export class ProviderUnreachable extends Error {
  constructor(readonly detail: string) {
    super(`identity provider unreachable: ${detail}`);
    this.name = "ProviderUnreachable";
  }
}

/** Raised when authentication succeeded but the subscription does not include fax. */
export class NotSubscribed extends Error {
  constructor(
    readonly email: string,
    readonly groups: readonly string[],
  ) {
    super(`${email} is not subscribed to fax`);
    this.name = "NotSubscribed";
  }
}
