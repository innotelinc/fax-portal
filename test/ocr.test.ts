import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, sweep, type Extractor, type PendingFax, type TextLedger } from "../src/ocr.ts";
import type { Runner } from "../src/pipeline.ts";

class Ledger implements TextLedger {
  readonly saved: { id: number; body: string; engine: string }[] = [];
  constructor(private readonly faxes: readonly PendingFax[]) {}

  async pending(limit: number): Promise<readonly PendingFax[]> {
    return this.faxes.slice(0, limit);
  }

  async saveText(faxid: number, body: string, engine: string): Promise<void> {
    this.saved.push({ id: faxid, body, engine });
  }
}

const extractors: readonly Extractor[] = [
  { name: "pdftotext", command: "/usr/bin/pdftotext", args: (path) => ["-q", "-layout", path, "-"] },
  { name: "ocr", command: "/usr/bin/ocrmypdf", args: (path) => ["--sidecar", "-", path] },
];

test("text is collapsed so the full-text index sees words, not layout", () => {
  assert.equal(normalise("Invoice   #42\r\n\r\n  Total\t\t 12.00\fPage 2"), "Invoice #42\nTotal 12.00\nPage 2");
  assert.equal(normalise("\u0000\u0007\n\n"), "");
});

test("a text-layer PDF is indexed by the first extractor only", async () => {
  const ledger = new Ledger([{ id: 5, path: "/archive/5.pdf" }]);
  const commands: string[] = [];
  const run: Runner = async (command) => {
    commands.push(command);
    return { stdout: "Account number 4451\nInvoice total 12.00\n", stderr: "" };
  };

  const result = await sweep({ ledger, run, extractors });
  assert.deepEqual(result, { indexed: 1, empty: 0, failed: 0 });
  assert.equal(ledger.saved[0]?.engine, "pdftotext");
  assert.match(ledger.saved[0]?.body ?? "", /Account number 4451/);
  assert.equal(commands.length, 1, "the OCR pass is skipped when text was found");
});

test("a scan falls through to OCR when the text layer is empty", async () => {
  const ledger = new Ledger([{ id: 6, path: "/archive/6.pdf" }]);
  const run: Runner = async (command) => {
    if (command.endsWith("ocrmypdf")) {
      return { stdout: "SIGNED AGREEMENT between the parties, dated May 2026.", stderr: "" };
    }
    return { stdout: "\f\f\n", stderr: "" };
  };

  const result = await sweep({ ledger, run, extractors });
  assert.deepEqual(result, { indexed: 1, empty: 0, failed: 0 });
  assert.equal(ledger.saved[0]?.engine, "ocr");
});

test("a fax with no extractable text leaves the queue with an empty record", async () => {
  const ledger = new Ledger([{ id: 7, path: "/archive/7.pdf" }]);
  const run: Runner = async () => ({ stdout: "", stderr: "" });

  const result = await sweep({ ledger, run, extractors });
  assert.deepEqual(result, { indexed: 0, empty: 1, failed: 0 });
  assert.deepEqual(ledger.saved, [{ id: 7, body: "", engine: "none" }]);
});

test("a missing binary does not burn the fax; the next extractor is tried", async () => {
  const ledger = new Ledger([{ id: 8, path: "/archive/8.pdf" }]);
  const run: Runner = async (command) => {
    if (command.endsWith("pdftotext")) {
      throw new Error("spawn pdftotext ENOENT");
    }
    return { stdout: "Second page of a scanned contract, 2026.", stderr: "" };
  };

  const result = await sweep({ ledger, run, extractors });
  assert.equal(result.indexed, 1);
  assert.equal(ledger.saved[0]?.engine, "ocr");
});

test("only the requested number of faxes is touched per pass", async () => {
  const ledger = new Ledger([
    { id: 1, path: "/archive/1.pdf" },
    { id: 2, path: "/archive/2.pdf" },
    { id: 3, path: "/archive/3.pdf" },
  ]);
  const run: Runner = async () => ({ stdout: "Some indexed text that is long enough.", stderr: "" });

  const result = await sweep({ ledger, run, extractors, limit: 2 });
  assert.equal(result.indexed, 2);
  assert.deepEqual(ledger.saved.map((row) => row.id), [1, 2]);
});
