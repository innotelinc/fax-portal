import type { Runner } from "./pipeline.ts";

/**
 * Full-text extraction for the archive.
 *
 * Two kinds of fax arrive: born-digital PDFs that already carry a text layer,
 * and scans that are pixels only. `pdftotext` handles the first cheaply; the
 * second needs a real OCR pass, so the engine chain is configurable and the
 * first extractor that produces usable text wins. Nothing here decides policy —
 * the sweep records what it found, including "nothing", so a fax is never
 * retried forever.
 */

export interface PendingFax {
  readonly id: number;
  readonly path: string;
}

export interface TextLedger {
  /** Faxes that are archived and not yet indexed, oldest first. */
  pending(limit: number): Promise<readonly PendingFax[]>;
  saveText(faxid: number, body: string, engine: string): Promise<void>;
}

export interface Extractor {
  readonly name: string;
  readonly command: string;
  readonly args: (path: string) => readonly string[];
}

/** Text-layer extraction first, then true OCR for scans. */
export function defaultExtractors(binDir = "/usr/bin"): readonly Extractor[] {
  return [
    {
      name: "pdftotext",
      command: `${binDir}/pdftotext`,
      args: (path) => ["-q", "-layout", path, "-"],
    },
    {
      name: "ocrmypdf",
      command: `${binDir}/ocrmypdf`,
      args: (path) => ["--skip-text", "--sidecar", "-", "--output-type", "pdf", path, "/dev/null"],
    },
  ];
}

export interface SweepOptions {
  readonly ledger: TextLedger;
  readonly run: Runner;
  readonly extractors?: readonly Extractor[];
  readonly limit?: number;
  readonly minChars?: number;
}

export interface SweepResult {
  readonly indexed: number;
  readonly empty: number;
  readonly failed: number;
}

/** One pass over unindexed faxes. The caller schedules the next pass. */
export async function sweep(options: SweepOptions): Promise<SweepResult> {
  const extractors = options.extractors ?? defaultExtractors();
  // Low enough that a short but real fax ("see attached invoice") is indexed,
  // high enough that OCR noise is not. A model that returns gibberish still
  // gets stored, it just gets stored as gibberish; this only decides when the
  // next extractor is worth trying.
  const minChars = options.minChars ?? 10;
  const batch = await options.ledger.pending(options.limit ?? 10);

  let indexed = 0;
  let empty = 0;
  let failed = 0;

  for (const fax of batch) {
    let recorded = false;
    for (const extractor of extractors) {
      let text: string;
      try {
        const result = await options.run(extractor.command, extractor.args(fax.path), 120_000);
        text = normalise(result.stdout);
      } catch {
        // A missing or failing extractor is not this fax's fault; try the next.
        continue;
      }
      if (text.length >= minChars) {
        await options.ledger.saveText(fax.id, text, extractor.name);
        indexed += 1;
        recorded = true;
        break;
      }
    }
    if (recorded) {
      continue;
    }
    // No text is a result, not an error: record it so it leaves the queue.
    try {
      await options.ledger.saveText(fax.id, "", "none");
      empty += 1;
    } catch {
      failed += 1;
    }
  }

  return { indexed, empty, failed };
}

/**
 * Fax text is full of column padding and form feeds. MySQL's full-text index
 * treats runs of whitespace as noise, so collapse them and drop control codes
 * before storing.
 */
export function normalise(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();
}
