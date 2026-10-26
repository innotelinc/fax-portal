import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, drain, sign, verify, type DeliveryLedger, type DeliveryTarget } from "../src/webhooks.ts";

const SECRET = "whsec_test_000000000000000000000000";
const PAYLOAD = JSON.stringify({ event: "fax.queued", jobId: 7 });

class Ledger implements DeliveryLedger {
  readonly delivered: number[] = [];
  readonly failed: { id: number; attempts: number; error: string }[] = [];

  async markDelivered(id: number): Promise<void> {
    this.delivered.push(id);
  }

  async markDeliveryFailed(id: number, attempts: number, error: string): Promise<void> {
    this.failed.push({ id, attempts, error });
  }
}

function target(patch: Partial<DeliveryTarget> = {}): DeliveryTarget {
  return { id: 1, url: "https://hooks.example.com/fax", secret: SECRET, event: "fax.queued", payload: PAYLOAD, attempts: 0, ...patch };
}

test("signatures verify, and stop verifying when anything changes", () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const header = `t=${timestamp},v1=${sign(SECRET, timestamp, PAYLOAD)}`;

  assert.equal(verify(SECRET, header, PAYLOAD), true);
  assert.equal(verify(SECRET, header, `${PAYLOAD} `), false, "body is covered");
  assert.equal(verify("whsec_other", header, PAYLOAD), false, "secret is covered");
});

test("a captured delivery cannot be replayed after the tolerance", () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const header = `t=${old},v1=${sign(SECRET, old, PAYLOAD)}`;
  assert.equal(verify(SECRET, header, PAYLOAD, 300), false);
});

test("a malformed signature header is rejected rather than thrown", () => {
  assert.equal(verify(SECRET, "", PAYLOAD), false);
  assert.equal(verify(SECRET, "v1=abc", PAYLOAD), false);
  assert.equal(verify(SECRET, "t=notanumber,v1=abc", PAYLOAD), false);
});

test("a 2xx marks the delivery delivered, with the signature header attached", async () => {
  const ledger = new Ledger();
  const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      headers: init.headers as Record<string, string>,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  assert.equal(await deliver(target(), ledger, fetchImpl), true);
  assert.deepEqual(ledger.delivered, [1]);
  assert.equal(ledger.failed.length, 0);
  const request = seen[0];
  assert.equal(request?.url, "https://hooks.example.com/fax");
  assert.equal(request?.headers["x-innotel-event"], "fax.queued");
  assert.equal(request?.body, PAYLOAD);
  assert.equal(verify(SECRET, request?.headers["x-innotel-signature"] ?? "", PAYLOAD), true);
});

test("a non-2xx records the attempt with its status and returns false", async () => {
  const ledger = new Ledger();
  const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

  assert.equal(await deliver(target(), ledger, fetchImpl), false);
  assert.deepEqual(ledger.failed, [{ id: 1, attempts: 1, error: "HTTP 503" }]);
});

test("a transport error is recorded too, and says none of the secret", async () => {
  const ledger = new Ledger();
  const fetchImpl = (async () => {
    throw new Error("connect ETIMEDOUT");
  }) as unknown as typeof fetch;

  assert.equal(await deliver(target({ attempts: 2 }), ledger, fetchImpl), false);
  assert.deepEqual(ledger.failed, [{ id: 1, attempts: 3, error: "Error: connect ETIMEDOUT" }]);
  assert.equal(JSON.stringify(ledger.failed).includes(SECRET), false);
});

test("drain reports how many endpoints accepted and how many did not", async () => {
  const ledger = new Ledger();
  const fetchImpl = (async (url: string) =>
    new Response("", { status: url.includes("good") ? 200 : 500 })) as unknown as typeof fetch;

  const result = await drain({
    due: async () => [
      target({ id: 1, url: "https://good.example.com" }),
      target({ id: 2, url: "https://bad.example.com" }),
      target({ id: 3, url: "https://good.example.com" }),
    ],
    ledger,
    fetchImpl,
  });

  assert.deepEqual(result, { delivered: 2, failed: 1 });
  assert.deepEqual(ledger.delivered, [1, 3]);
});
