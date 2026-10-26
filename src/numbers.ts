/**
 * One place where a fax number becomes canonical.
 *
 * Everything the portal dials, stores or matches goes through here: send, the
 * address book, DID lines and email-to-fax. Formatting is stripped, anything
 * that is not E.164 is refused rather than guessed at — an ambiguous number is
 * a fax sent to the wrong machine.
 */
export function normaliseFaxNumber(value: unknown): string | null {
  const candidate = String(value ?? "").replace(/[\s().\u2010-\u2015-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(candidate)) {
    return null;
  }
  return candidate;
}
