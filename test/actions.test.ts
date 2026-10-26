import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAction, planActions } from "../src/actions.ts";

test("a confident category is filed and announced", () => {
  assert.deepEqual(planActions({ category: "invoice", confidence: 0.92, status: "auto" }), {
    label: "invoice",
    flag: false,
    notify: true,
  });
});

test("an uncertain category is flagged, never filed", () => {
  assert.deepEqual(planActions({ category: "invoice", confidence: 0.4, status: "needs_review" }), {
    label: null,
    flag: true,
    notify: false,
  });
});

test("a failed classification asks for a human and stays quiet", () => {
  assert.deepEqual(planActions({ category: "other", confidence: 0, status: "failed" }), {
    label: null,
    flag: true,
    notify: false,
  });
});

test("'other' is reported but not filed, because there is nothing to file it under", () => {
  assert.deepEqual(planActions({ category: "other", confidence: 0.95, status: "auto" }), {
    label: null,
    flag: false,
    notify: true,
  });
});

test("with auto-filing switched off, everything waits for a person", () => {
  assert.deepEqual(planActions({ category: "medical", confidence: 0.99, status: "auto" }, { autoFile: false }), {
    label: null,
    flag: true,
    notify: false,
  });
});

test("the audit text says what happened and how sure the model was", () => {
  const decision = { category: "invoice", confidence: 0.92 };
  assert.deepEqual(describeAction({ label: "invoice", flag: false, notify: true }, decision), [
    "filed as invoice (92% confident)",
    "notified webhooks: invoice",
  ]);
  assert.deepEqual(describeAction({ label: null, flag: true, notify: false }, decision), [
    "flagged for human review",
  ]);
});
