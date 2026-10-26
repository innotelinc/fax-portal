import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";
import { Auth, NotSubscribed, ProviderUnreachable, type PendingLogin } from "../src/auth.ts";
import type { Config } from "../src/config.ts";

const ISSUER = "https://auth.example.test/application/o/fax-staging/";
const CLIENT_ID = "fax-staging";
const CLIENT_SECRET = "shhh";
const ORIGIN = "https://fax-staging.example.test";

const CONFIG: Config = {
  port: 3000,
  publicOrigin: ORIGIN,
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  allowedGroups: ["Zeus", "Capstone"],
  adminGroups: ["cerulean-platform"],
  sessionSecret: "x".repeat(32),
  database: { host: "db", port: 3306, user: "u", password: "p", database: "avantfax" },
  hylafax: {
    binDir: "/usr/sbin",
    spoolDir: "/var/spool/hylafax",
    callerId: "fax@example.test",
    archiveDir: "/archive",
    quarantineDir: "/q",
    ghostscriptBin: "/usr/bin/gs",
    pdftotextBin: "/usr/bin/pdftotext",
    ocrBin: "",
  },
  inboundEmailSecret: "",
  triage: { enabled: false, baseUrl: "https://api.z.ai/v1", apiKey: "", model: "m", provider: "test", minConfidence: 0.75, maxChars: 6000 },
};

const DISCOVERY = {
  issuer: ISSUER,
  // The whole point: authorize and token are NOT under the issuer path.
  authorization_endpoint: "https://auth.example.test/application/o/authorize/",
  token_endpoint: "https://auth.example.test/application/o/token/",
  jwks_uri: "https://auth.example.test/application/o/fax-staging/jwks/",
  end_session_endpoint: "https://auth.example.test/application/o/end-session/",
};

async function signingKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { jwk, privateKey };
}

interface IdTokenOptions {
  readonly email?: string;
  readonly groups?: string[];
  readonly audience?: string;
  readonly issuer?: string;
  readonly kid?: string;
}

async function idToken(privateKey: KeyLike, options: IdTokenOptions = {}) {
  return new SignJWT({
    email: options.email ?? "alice@example.test",
    preferred_username: "alice",
    name: "Alice Client",
    groups: options.groups ?? ["Zeus"],
  })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** A fake provider whose token exchange answers with `tokenFor`. */
function provider(options: {
  keys: JWK[];
  tokenFor: (body: URLSearchParams) => Promise<unknown> | unknown;
  onKeys?: () => void;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    }
    if (url === DISCOVERY.jwks_uri) {
      // Read the published set before any rotation hook runs, so a test can
      // model "the cache holds the old key" exactly.
      const keys = options.keys;
      options.onKeys?.();
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }
    if (url === DISCOVERY.token_endpoint) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const answer = await options.tokenFor(body);
      if (answer instanceof Response) {
        return answer;
      }
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("the authorize URL comes from discovery, not from the issuer path", async () => {
  const { jwk } = await signingKey("k1");
  const { fetchImpl } = provider({ keys: [jwk], tokenFor: () => ({}) });
  const auth = new Auth(CONFIG, fetchImpl);

  const { url, pending } = await auth.begin("/outbox");
  const parsed = new URL(url);

  assert.equal(`${parsed.origin}${parsed.pathname}`, DISCOVERY.authorization_endpoint);
  assert.equal(parsed.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(parsed.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback`);
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("code_challenge")?.length, 43);
  assert.equal(parsed.searchParams.get("state"), pending.state);
  assert.equal(pending.redirectTo, "/outbox");
  assert.ok((pending.verifier ?? "").length >= 43);
});

test("the token exchange posts to the discovered endpoint and the identity is read from the id_token", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  const seen: { body?: URLSearchParams } = {};
  const token = await idToken(privateKey, { groups: ["Zeus", "cerulean-platform"] });
  const { fetchImpl } = provider({
    keys: [jwk],
    tokenFor: (body) => {
      seen.body = body;
      return { id_token: token };
    },
  });
  const auth = new Auth(CONFIG, fetchImpl);
  const pending: PendingLogin = { state: "s", verifier: "verifier-abc", redirectTo: "/" };

  const identity = await auth.complete("the-code", pending);
  assert.equal(identity.email, "alice@example.test");
  assert.equal(identity.displayName, "Alice Client");
  assert.equal(identity.isAdmin, true);
  assert.deepEqual(identity.groups, ["Zeus", "cerulean-platform"]);

  assert.equal(seen.body?.get("grant_type"), "authorization_code");
  assert.equal(seen.body?.get("code"), "the-code");
  assert.equal(seen.body?.get("code_verifier"), "verifier-abc");
  assert.equal(seen.body?.get("redirect_uri"), `${ORIGIN}/auth/callback`);
  assert.equal(seen.body?.get("client_secret"), CLIENT_SECRET);
});

test("a valid token for a subscriber without the product group is refused", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  const token = await idToken(privateKey, { groups: ["SomeOtherProduct"] });
  const { fetchImpl } = provider({ keys: [jwk], tokenFor: () => ({ id_token: token }) });
  const auth = new Auth(CONFIG, fetchImpl);

  await assert.rejects(
    () => auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" }),
    (error: unknown) => error instanceof NotSubscribed && error.email === "alice@example.test",
  );
});

test("a token for another audience or another issuer is not accepted", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  for (const options of [{ audience: "someone-else" }, { issuer: "https://evil.test/" }]) {
    const token = await idToken(privateKey, options);
    const { fetchImpl } = provider({ keys: [jwk], tokenFor: () => ({ id_token: token }) });
    const auth = new Auth(CONFIG, fetchImpl);
    await assert.rejects(
      () => auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" }),
      /id_token rejected/,
    );
  }
});

test("an issuer written without the trailing slash is the same issuer", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  const token = await idToken(privateKey, { issuer: ISSUER.replace(/\/$/, "") });
  const { fetchImpl } = provider({ keys: [jwk], tokenFor: () => ({ id_token: token }) });
  const auth = new Auth(CONFIG, fetchImpl);

  const identity = await auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" });
  assert.equal(identity.email, "alice@example.test");
});

// The shape production actually runs in: loadConfig strips the trailing slash
// from FAX_OIDC_ISSUER, and Authentik's code-flow tokens carry one.
test("an issuer with the trailing slash is accepted when the config has none", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  const token = await idToken(privateKey, { issuer: ISSUER });
  const { fetchImpl } = provider({ keys: [jwk], tokenFor: () => ({ id_token: token }) });
  const auth = new Auth({ ...CONFIG, issuer: ISSUER.replace(/\/$/, "") }, fetchImpl);

  const identity = await auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" });
  assert.equal(identity.email, "alice@example.test");
});

test("a rejection reports the claims that were actually presented", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  const token = await idToken(privateKey, { issuer: "https://other-idp.test/application/o/fax/" });
  const { fetchImpl } = provider({ keys: [jwk], tokenFor: () => ({ id_token: token }) });
  const auth = new Auth(CONFIG, fetchImpl);

  await assert.rejects(
    () => auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" }),
    (error: unknown) =>
      error instanceof Error &&
      /unexpected "iss" claim value/.test(error.message) &&
      error.message.includes("https://other-idp.test/application/o/fax/") &&
      error.message.includes(ISSUER),
  );
});

test("a rotated signing key is picked up on the next attempt", async () => {
  const oldKey = await signingKey("k1");
  const newKey = await signingKey("k2");
  let published: JWK[] = [oldKey.jwk];
  const { fetchImpl } = provider({
    get keys() {
      return published;
    },
    onKeys: () => {
      published = [newKey.jwk];
    },
    tokenFor: () => ({ id_token: token }),
  });

  // The first verification warms the cache with k1; the token is then signed
  // with k2, which the cache does not have.
  const auth = new Auth(CONFIG, fetchImpl);
  const token = await idToken(newKey.privateKey, { kid: "k2" });
  const identity = await auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" });
  assert.equal(identity.email, "alice@example.test");
});

test("discovery failure is reported, and retried rather than cached forever", async () => {
  let attempts = 0;
  const { jwk } = await signingKey("k1");
  const healthy = provider({ keys: [jwk], tokenFor: () => ({}) }).fetchImpl;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("ECONNREFUSED");
    }
    return healthy(url, init);
  }) as unknown as typeof fetch;

  const auth = new Auth(CONFIG, fetchImpl);
  await assert.rejects(() => auth.begin("/"));
  const { url } = await auth.begin("/");
  assert.equal(new URL(url).pathname, new URL(DISCOVERY.authorization_endpoint).pathname);
  assert.equal(attempts, 2);
});

test("a dropped connection is retried once, so a stale pooled socket is not a failed sign-in", async () => {
  const { jwk, privateKey } = await signingKey("k1");
  const token = await idToken(privateKey);
  const healthy = provider({ keys: [jwk], tokenFor: () => ({ id_token: token }) });
  let tokenAttempts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === DISCOVERY.token_endpoint) {
      tokenAttempts += 1;
      if (tokenAttempts === 1) {
        const refused = new Error("fetch failed") as Error & { cause?: unknown };
        refused.cause = Object.assign(new Error("connect ECONNREFUSED 192.168.1.71:443"), {
          code: "ECONNREFUSED",
          address: "192.168.1.71",
          port: 443,
        });
        throw refused;
      }
    }
    return healthy.fetchImpl(url, init);
  }) as unknown as typeof fetch;

  const auth = new Auth(CONFIG, fetchImpl);
  const identity = await auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" });
  assert.equal(identity.email, "alice@example.test");
  assert.equal(tokenAttempts, 2);
});

test("an unreachable provider is reported with the errno behind the failure", async () => {
  const { jwk } = await signingKey("k1");
  const healthy = provider({ keys: [jwk], tokenFor: () => ({}) }).fetchImpl;
  let tokenAttempts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === DISCOVERY.token_endpoint) {
      tokenAttempts += 1;
      const refused = new Error("fetch failed") as Error & { cause?: unknown };
      refused.cause = Object.assign(new Error("connect ECONNREFUSED 192.168.1.71:443"), {
        code: "ECONNREFUSED",
        address: "192.168.1.71",
        port: 443,
      });
      throw refused;
    }
    return healthy(url, init);
  }) as unknown as typeof fetch;

  const auth = new Auth(CONFIG, fetchImpl);
  await assert.rejects(
    () => auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderUnreachable);
      assert.match(error.detail, /ECONNREFUSED 192\.168\.1\.71:443/);
      return true;
    },
  );
  assert.equal(tokenAttempts, 2);
});

test("sign-out uses the discovered end-session endpoint and survives an unreachable provider", async () => {
  const { jwk } = await signingKey("k1");
  const healthy = new Auth(CONFIG, provider({ keys: [jwk], tokenFor: () => ({}) }).fetchImpl);
  const url = await healthy.logoutUrl();
  assert.equal(url, `${DISCOVERY.end_session_endpoint}?post_logout_redirect_uri=${encodeURIComponent(ORIGIN)}`);

  const offline = new Auth(CONFIG, (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch);
  assert.match(await offline.logoutUrl(), /end-session/);
});

test("an unreachable token endpoint is a transport failure, not a rejection", async () => {
  const { jwk } = await signingKey("k1");
  const healthy = provider({ keys: [jwk], tokenFor: () => ({}) }).fetchImpl;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === DISCOVERY.token_endpoint) {
      throw new TypeError("fetch failed: Connect Timeout Error");
    }
    return healthy(url, init);
  }) as unknown as typeof fetch;

  const auth = new Auth(CONFIG, fetchImpl);
  await assert.rejects(
    () => auth.complete("code", { state: "s", verifier: "v", redirectTo: "/" }),
    (error: unknown) => error instanceof ProviderUnreachable && /Connect Timeout/.test(error.detail),
  );
});

test("reachability reports an unreachable issuer and recovers without hammering it", async () => {
  let failing = true;
  const { jwk } = await signingKey("k1");
  const healthy = provider({ keys: [jwk], tokenFor: () => ({}) }).fetchImpl;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (failing) {
      throw new TypeError("fetch failed: Connect Timeout Error");
    }
    return healthy(url, init);
  }) as unknown as typeof fetch;

  const auth = new Auth(CONFIG, fetchImpl);
  const down = await auth.reachable();
  assert.equal(down.ok, false);
  assert.match(down.detail, /Connect Timeout/);

  // Within the cache window the same verdict is served, not a fresh probe.
  failing = false;
  assert.equal((await auth.reachable()).ok, false);
});
