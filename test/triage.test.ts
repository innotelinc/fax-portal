import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  classifyFax,
  parseDecision,
  sha256,
  statusFor,
  sweepTriage,
  type TriageConfig,
  type TriageLedger,
} from "../src/triage.ts";
import type { TriageCandidate, TriageDecision } from "../src/store.ts";

const CONFIG: TriageConfig = {
  baseUrl: "https://api.z.ai/v1",
  apiKey: "test-key",
  model: "auto/cheap",
  provider: "openai-compatible",
  minConfidence: 0.75,
  maxChars: 6000,
};

function reply(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

class Ledger implements TriageLedger {
  readonly saved: TriageDecision[] = [];
  constructor(private readonly candidates: readonly TriageCandidate[]) {}

  async pendingTriage(limit: number): Promise<readonly TriageCandidate[]> {
    return this.candidates.slice(0, limit);
  }

  async saveTriage(decision: TriageDecision): Promise<void> {
    this.saved.push(decision);
  }
}

test("a decision is read from plain JSON, a fenced block, or with chatter around it", () => {
  assert.deepEqual(parseDecision('{"category":"invoice","counterparty":"Acme","confidence":0.9}'), {
    category: "invoice",
    counterparty: "Acme",
    confidence: 0.9,
  });
  assert.equal(parseDecision('```json\n{"category":"legal","confidence":0.5}\n```')?.category, "legal");
  assert.equal(parseDecision('Sure! {"category":"Medical","confidence":0.8} Hope that helps.')?.category, "medical");
});

test("anything outside the closed set is refused", () => {
  assert.equal(parseDecision('{"category":"taxes","confidence":0.99}'), null);
  assert.equal(parseDecision('{"category":"invoice"}'), null, "confidence is required");
  assert.equal(parseDecision('{"confidence":0.9}'), null, "category is required");
  assert.equal(parseDecision("I think it is an invoice."), null);
  assert.equal(parseDecision(""), null);
});

test("confidence is clamped and counterparty sanitised", () => {
  assert.equal(parseDecision('{"category":"invoice","confidence":7}')?.confidence, 1);
  assert.equal(parseDecision('{"category":"invoice","confidence":-2}')?.confidence, 0);
  const decision = parseDecision(
    `{"category":"invoice","counterparty":"${"a".repeat(400)}","confidence":0.5}`,
  );
  assert.equal(decision?.counterparty.length, 190);
});

test("the prompt treats the fax as data and bounds its length", () => {
  const prompt = buildPrompt("invoice 42", 10);
  assert.match(prompt.system, /untrusted DATA/i);
  assert.match(prompt.user, /<<<\ninvoice 42\n>>>/);
  assert.equal(buildPrompt("x".repeat(10_000), 50).user.includes("x".repeat(51)), false);
});

test("the provider is called server-side with the configured model and key", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(
      JSON.stringify({
        // A router answers with the backend it actually used; that is what the
        // audit trail should record, not the alias we asked for.
        model: "router-picked-model",
        choices: [{ message: { content: '{"category":"invoice","confidence":0.9}' } }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await classifyFax(7, "invoice 42 total 12.00", CONFIG, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.decision.category, "invoice");
  assert.equal(result.ok === true && result.model, "router-picked-model");

  const call = seen[0];
  assert.equal(call?.url, "https://api.z.ai/v1/chat/completions");
  const headers = call?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
  assert.equal(body.model, CONFIG.model);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("a server that rejects response_format is asked again without it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.response_format) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: response_format" } }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ model: "plain", choices: [{ message: { content: '{"category":"legal","confidence":0.8}' } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await classifyFax(1, "lease agreement text", CONFIG, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.decision.category, "legal");
  assert.equal(bodies.length, 2);
  assert.equal("response_format" in (bodies[1] ?? {}), false);
});

test("provider failures are classified as retryable or not", async () => {
  const rateLimited = await classifyFax(1, "x", CONFIG, reply("slow down", 429));
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.ok === false && rateLimited.retry, true);

  const serverError = await classifyFax(2, "x", CONFIG, reply("boom", 503));
  assert.equal(serverError.ok === false && serverError.retry, true);

  const badRequest = await classifyFax(3, "x", CONFIG, reply("no", 401));
  assert.equal(badRequest.ok === false && badRequest.retry, false);

  const garbage = await classifyFax(4, "x", CONFIG, reply("I cannot help with that."));
  assert.equal(garbage.ok === false && garbage.retry, false);

  const unreachable = await classifyFax(5, "x", CONFIG, (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch);
  assert.equal(unreachable.ok === false && unreachable.retry, true);
});

test("confidence decides between automatic and human review", () => {
  assert.equal(statusFor(0.9, 0.75), "auto");
  assert.equal(statusFor(0.75, 0.75), "auto");
  assert.equal(statusFor(0.74, 0.75), "needs_review");
});

test("a pass saves decisions, flags low confidence, records failures, defers retries", async () => {
  const ledger = new Ledger([
    { faxid: 1, text: "invoice 42 from Acme, total 12.00, due 30 days" },
    { faxid: 2, text: "court order regarding the tenancy agreement, hearing date" },
    { faxid: 3, text: "unknown content that the model will refuse to classify" },
    { faxid: 4, text: "another document the provider is currently rate limiting" },
  ]);
  const responses = [
    '{"category":"invoice","counterparty":"Acme","confidence":0.92}',
    '{"category":"legal","counterparty":"County Court","confidence":0.4}',
    "no idea",
    "rate limited",
  ];
  let call = 0;
  const fetchImpl = (async () => {
    const index = call++;
    if (index === 3) {
      return new Response(JSON.stringify({ error: "slow down" }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: responses[index] } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const acted: number[] = [];
  const result = await sweepTriage({
    ledger,
    config: CONFIG,
    fetchImpl,
    limit: 10,
    onDecision: async (decision) => {
      acted.push(decision.faxid);
    },
  });

  assert.deepEqual(result, { triaged: 2, needsReview: 1, failed: 1, deferred: 1 });
  assert.deepEqual(acted, [1, 2], "only decisions that were stored are acted on");
  const byFax = new Map(ledger.saved.map((row) => [row.faxid, row]));
  assert.equal(byFax.get(1)?.status, "auto");
  assert.equal(byFax.get(1)?.category, "invoice");
  assert.equal(byFax.get(2)?.status, "needs_review");
  assert.equal(byFax.get(3)?.status, "failed");
  assert.equal(byFax.has(4), false, "a rate-limited fax is retried, not recorded as a decision");

  const audit = byFax.get(1);
  assert.equal(audit?.inputSha256, sha256("invoice 42 from Acme, total 12.00, due 30 days"));
  assert.equal(audit?.promptVersion.length, 1);
  assert.ok(audit?.outputJson.includes("invoice"));
});
