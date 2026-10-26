import type { TriageDecision } from "./store.ts";

/**
 * What the portal does with a classification.
 *
 * The policy is deliberately small and boring: a confident category files the
 * fax under a label and tells the customer's webhook; anything uncertain is
 * flagged for a human and nothing is filed. Nothing here deletes, forwards or
 * dials anything — the worst a wrong category can do is put a fax under the
 * wrong label, which is visible and reversible.
 */
export interface ActionPlan {
  /** Label to file the fax under, or null. */
  readonly label: string | null;
  /** Needs a human to look at it. */
  readonly flag: boolean;
  /** The customer's webhook should hear about it. */
  readonly notify: boolean;
}

export interface ActionPolicy {
  /** File confident categories automatically. Off means flag everything. */
  readonly autoFile?: boolean;
}

export function planActions(
  decision: Pick<TriageDecision, "category" | "confidence" | "status">,
  policy: ActionPolicy = {},
): ActionPlan {
  const autoFile = policy.autoFile ?? true;

  if (decision.status === "failed") {
    // The model could not answer; that is a reason for a human, not a label.
    return { label: null, flag: true, notify: false };
  }
  if (decision.status === "needs_review") {
    return { label: null, flag: true, notify: false };
  }
  if (!autoFile) {
    return { label: null, flag: true, notify: false };
  }
  if (decision.category === "other") {
    // "Other" is a real answer but not a place to file anything.
    return { label: null, flag: false, notify: true };
  }
  return { label: decision.category, flag: false, notify: true };
}

/** Human-readable audit text for one applied action. */
export function describeAction(plan: ActionPlan, decision: Pick<TriageDecision, "category" | "confidence">): readonly string[] {
  const lines: string[] = [];
  if (plan.label) {
    lines.push(`filed as ${plan.label} (${Math.round(decision.confidence * 100)}% confident)`);
  }
  if (plan.flag) {
    lines.push("flagged for human review");
  }
  if (plan.notify) {
    lines.push(`notified webhooks: ${decision.category}`);
  }
  return lines;
}
