import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, retried webhook delivery.
 *
 * The signature covers the timestamp as well as the body, so a captured
 * delivery cannot be replayed later: receivers reject anything older than their
 * tolerance. The header is Stripe-shaped (`t=<unix>,v1=<hex>`) because every
 * integration already knows how to read that.
 */
export interface DeliveryTarget {
  readonly id: number;
  readonly url: string;
  readonly secret: string;
  readonly event: string;
  readonly payload: string;
  readonly attempts: number;
}

export interface DeliveryLedger {
  markDelivered(id: number): Promise<void>;
  markDeliveryFailed(id: number, attempts: number, error: string): Promise<void>;
}

export function sign(secret: string, timestamp: number, payload: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

export function verify(secret: string, header: string, payload: string, toleranceSeconds = 300): boolean {
  const parts = new Map(
    header
      .split(",")
      .map((piece) => piece.split("=") as [string, string])
      .filter(([key, value]) => Boolean(key) && value !== undefined),
  );
  const timestamp = Number(parts.get("t"));
  const provided = parts.get("v1");
  if (!Number.isFinite(timestamp) || !provided) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(sign(secret, timestamp, payload), "hex");
  const actual = Buffer.from(provided, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function deliver(
  target: DeliveryTarget,
  ledger: DeliveryLedger,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(target.secret, timestamp, target.payload);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Innotel-Fax-Webhooks/1",
        "x-innotel-event": target.event,
        "x-innotel-signature": `t=${timestamp},v1=${signature}`,
      },
      body: target.payload,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 200 && response.status < 300) {
      await ledger.markDelivered(target.id);
      return true;
    }
    await ledger.markDeliveryFailed(target.id, target.attempts + 1, `HTTP ${response.status}`);
    return false;
  } catch (error) {
    await ledger.markDeliveryFailed(target.id, target.attempts + 1, String(error).slice(0, 200));
    return false;
  }
}

export interface DrainOptions {
  readonly due: (limit: number) => Promise<readonly DeliveryTarget[]>;
  readonly ledger: DeliveryLedger;
  readonly fetchImpl?: typeof fetch;
  readonly limit?: number;
}

/** One pass over the queue; the caller schedules the next pass. */
export async function drain(options: DrainOptions): Promise<{ delivered: number; failed: number }> {
  const batch = await options.due(options.limit ?? 20);
  let delivered = 0;
  let failed = 0;
  for (const target of batch) {
    const ok = await deliver(target, options.ledger, options.fetchImpl ?? fetch);
    if (ok) {
      delivered += 1;
    } else {
      failed += 1;
    }
  }
  return { delivered, failed };
}
