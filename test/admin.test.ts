import { test } from "node:test";
import assert from "node:assert/strict";
import { canChangeAccount, type AccountRef } from "../src/admin.ts";
import { normaliseFaxNumber } from "../src/numbers.ts";

const admin = (uid: number, patch: Partial<AccountRef> = {}): AccountRef => ({
  uid,
  email: `admin${uid}@example.test`,
  isAdmin: true,
  enabled: true,
  ...patch,
});

const client = (uid: number, patch: Partial<AccountRef> = {}): AccountRef => ({
  uid,
  email: `client${uid}@example.test`,
  isAdmin: false,
  enabled: true,
  ...patch,
});

test("an administrator cannot disable or demote themselves", () => {
  const self = admin(1);
  const all = [self, admin(2)];
  assert.equal(canChangeAccount(self, self, "disable", all).allowed, false);
  assert.equal(canChangeAccount(self, self, "revoke-admin", all).allowed, false);
  assert.equal(canChangeAccount(self, self, "enable", all).allowed, true);
});

test("the last enabled administrator is protected from everyone", () => {
  const last = admin(1);
  const actor = admin(2, { enabled: false });
  assert.equal(canChangeAccount(actor, last, "revoke-admin", [last, actor]).allowed, false);
  assert.equal(canChangeAccount(actor, last, "disable", [last, actor]).allowed, false);
  assert.match(
    canChangeAccount(actor, last, "revoke-admin", [last, actor]).reason ?? "",
    /last enabled administrator/,
  );
});

test("with a second administrator in place, demotion is allowed", () => {
  const target = admin(1);
  const actor = admin(2);
  assert.equal(canChangeAccount(actor, target, "revoke-admin", [target, actor]).allowed, true);
  assert.equal(canChangeAccount(actor, target, "disable", [target, actor]).allowed, true);
});

test("clients can be disabled and administrators granted", () => {
  const actor = admin(1);
  const target = client(2);
  assert.equal(canChangeAccount(actor, target, "disable", [actor, target]).allowed, true);
  assert.equal(canChangeAccount(actor, target, "grant-admin", [actor, target]).allowed, true);
});

test("a fax number is canonicalised or refused, never guessed", () => {
  assert.equal(normaliseFaxNumber("+1 (555) 987-6543"), "+15559876543");
  assert.equal(normaliseFaxNumber("  +44 20 7946 0958  "), "+442079460958");
  assert.equal(normaliseFaxNumber("+1\u2010555\u2010987\u20106543"), "+15559876543", "en dashes are formatting");
  assert.equal(normaliseFaxNumber("555-1234"), null, "no country code");
  assert.equal(normaliseFaxNumber("+0123456789"), null, "no zero after +");
  assert.equal(normaliseFaxNumber("+1555CALLNOW"), null);
  assert.equal(normaliseFaxNumber(""), null);
  assert.equal(normaliseFaxNumber(undefined), null);
  assert.equal(normaliseFaxNumber("+1555123456789012345"), null, "longer than E.164 allows");
});
