import { test } from "node:test";
import assert from "node:assert/strict";
import { addressOf, destinationOf, parseMessage } from "../src/email-to-fax.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");

function message(parts: { headers?: string; body: string }): Buffer {
  return Buffer.from(
    `${parts.headers ?? "From: Alice <alice@example.com>\nTo: +15551234567@fax.innotel.us\nSubject: Invoice\nMIME-Version: 1.0\n"}${parts.body}`,
    "utf8",
  );
}

test("a base64 PDF attachment is extracted and its subject decoded", () => {
  const raw = message({
    headers:
      "From: Alice <ALICE@example.com>\n" +
      "To: +15551234567@fax.innotel.us\n" +
      "Subject: =?utf-8?B?SW52b2ljZSAjNDI=?=\n" +
      'Content-Type: multipart/mixed; boundary="b1"\n',
    body:
      "\n--b1\nContent-Type: text/plain; charset=utf-8\n\nSee the attached invoice.\n" +
      "--b1\n" +
      'Content-Type: application/pdf; name="invoice.pdf"\n' +
      'Content-Disposition: attachment; filename="invoice.pdf"\n' +
      "Content-Transfer-Encoding: base64\n\n" +
      `${PDF.toString("base64")}\n` +
      "--b1--\n",
  });

  const parsed = parseMessage(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.message.subject, "Invoice #42");
  assert.equal(addressOf(parsed.message.from), "alice@example.com");
  assert.equal(parsed.message.attachmentName, "invoice.pdf");
  assert.deepEqual(parsed.message.pdf, PDF);
});

test("an attachment is identified by its bytes, not by its filename", () => {
  const raw = message({
    headers: 'From: a@example.com\nTo: bob@example.com\nContent-Type: multipart/mixed; boundary="x"\n',
    body:
      "\n--x\n" +
      'Content-Type: application/octet-stream; name="scan.txt"\n' +
      "Content-Disposition: attachment; filename=\"scan.txt\"\n" +
      "Content-Transfer-Encoding: base64\n\n" +
      `${PDF.toString("base64")}\n--x--\n`,
  });

  const parsed = parseMessage(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.message.pdf, PDF, "a PDF called scan.txt is still a PDF");
});

test("a file that claims to be a PDF but is not is ignored", () => {
  const raw = message({
    headers: 'From: a@example.com\nContent-Type: multipart/mixed; boundary="x"\n',
    body:
      "\n--x\n" +
      'Content-Type: application/pdf; name="invoice.pdf"\n' +
      'Content-Disposition: attachment; filename="invoice.pdf"\n\n' +
      "MZ\u0000\u0000this is a windows executable\n--x--\n",
  });

  const parsed = parseMessage(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.message.pdf, null);
});

test("a message with no attachment parses, with pdf null", () => {
  const raw = message({ body: "\nJust a note, nothing attached.\n" });
  const parsed = parseMessage(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.message.pdf, null);
});

test("quoted-printable bodies are decoded", () => {
  const raw = message({
    headers: 'From: a@example.com\nContent-Type: multipart/mixed; boundary="q"\n',
    body:
      "\n--q\nContent-Type: text/plain\n\nnothing here\n" +
      "--q\n" +
      'Content-Type: application/pdf; name="a.pdf"\n' +
      "Content-Transfer-Encoding: quoted-printable\n\n" +
      "%PDF-1.4=0A%EOF=0A\n--q--\n",
  });

  const parsed = parseMessage(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.ok(parsed.message.pdf?.toString("latin1").startsWith("%PDF-1.4"));
});

test("mail without a From header is refused", () => {
  const parsed = parseMessage("Subject: hello\n\nbody\n");
  assert.deepEqual(parsed, { ok: false, reason: "message has no From header" });
});

test("an empty message is refused", () => {
  assert.deepEqual(parseMessage(Buffer.alloc(0)), { ok: false, reason: "empty message" });
});

test("the fax number comes from the To header or the subject", () => {
  assert.equal(destinationOf("+1 (555) 123-4567@fax.innotel.us", ""), "+15551234567");
  assert.equal(destinationOf("fax@innotel.us", "Please send to +44 20 7946 0958 today"), "+442079460958");
  assert.equal(destinationOf("fax@innotel.us", "no number here"), null);
  assert.equal(destinationOf("fax@innotel.us", "call 555-1234"), null, "short numbers are not E.164");
});

test("addressOf strips display names and rejects garbage", () => {
  assert.equal(addressOf('"Smith, Bob" <bob@example.com>'), "bob@example.com");
  assert.equal(addressOf("not-an-address"), "");
});
