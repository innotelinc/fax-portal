import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { coverScratch, mergePdfs, renderCoverPdf } from "./cover.ts";

/**
 * Upload acceptance, in the only order that is safe:
 *
 *   quarantine → sniff + size check → hash → normalise with Ghostscript →
 *   hand the *normalised* PDF to sendfax → record what happened.
 *
 * Nothing the browser sends is ever passed to HylaFAX. That is what stops a
 * polyglot file (a PDF that is also an executable) from becoming a document the
 * fax server will happily spool, and it is why the extension and the declared
 * content-type are never trusted — only magic bytes are.
 *
 * Every side effect is injected so the whole path is testable without root, a
 * fax modem, or Ghostscript installed.
 */

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

export interface JobLedger {
  createJob(job: { accountUid: number; to: string; sha256: string }): Promise<number>;
  updateJob(
    id: number,
    status: "quarantined" | "normalising" | "queued" | "failed",
    patch?: { hylafaxJob?: string; detail?: string; pages?: number },
  ): Promise<void>;
}

export interface PipelineOptions {
  readonly quarantineDir: string;
  readonly spoolDir: string;
  readonly callerId: string;
  readonly ghostscriptBin: string;
  readonly sendfaxBin: string;
  readonly ledger: JobLedger;
  readonly run: Runner;
  readonly maxBytes?: number;
}

export type UploadResult =
  | { readonly ok: true; readonly jobId: number; readonly hylafaxJob: string; readonly pages: number }
  | { readonly ok: false; readonly code: number; readonly reason: string };

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export async function acceptUpload(
  options: PipelineOptions,
  accountUid: number,
  to: string,
  file: {
    stream: Readable;
    filename: string;
    /** Optional cover page, rendered here — never uploaded. */
    cover?: { title: string; body: string };
  },
): Promise<UploadResult> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  await mkdir(options.quarantineDir, { recursive: true, mode: 0o700 });

  const token = randomUUID();
  const quarantined = join(options.quarantineDir, `${token}.upload`);
  const normalised = join(options.spoolDir, `portal-${token}.pdf`);

  try {
    const bytes = await capture(options.quarantineDir, quarantined, file.stream, maxBytes);
    if (bytes.code !== 0) {
      return { ok: false, code: bytes.code, reason: bytes.reason };
    }

    const sha256 = await hashFile(quarantined);
    const jobId = await options.ledger.createJob({ accountUid, to, sha256 });
    await options.ledger.updateJob(jobId, "normalising");

    await mkdir(options.spoolDir, { recursive: true, mode: 0o700 });
    const gs = await options.run(
      options.ghostscriptBin,
      [
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        // Flatten anything active: no launch actions, no embedded JS.
        "-dPDFSETTINGS=/prepress",
        "-dDetectDuplicateImages=true",
        `-sOutputFile=${normalised}`,
        quarantined,
      ],
      120_000,
    ).catch((error: unknown) => ({ stdout: "", stderr: String(error) }));
    if (!(await exists(normalised))) {
      await options.ledger.updateJob(jobId, "failed", { detail: `normalisation failed: ${gs.stderr.slice(0, 200)}` });
      return { ok: false, code: 422, reason: "the document could not be converted to a faxable PDF" };
    }

    // Ghostscript writes 0644; the document is the customer's, not the host's.
    await chmod(normalised, 0o640).catch(() => undefined);

    let document = normalised;
    if (file.cover) {
      const scratch = await coverScratch();
      try {
        const context = { run: options.run, ghostscriptBin: options.ghostscriptBin };
        const coverPdf = await renderCoverPdf(
          context,
          file.cover.title,
          file.cover.body,
          {
            to,
            from: options.callerId,
            date: new Date().toISOString().slice(0, 10),
            subject: file.filename,
            pages: await countPages(options.run, options.ghostscriptBin, normalised),
          },
          scratch.dir,
        );
        const merged = join(options.spoolDir, `portal-${token}-cover.pdf`);
        await mergePdfs(context, [coverPdf, normalised], merged);
        if (!(await exists(merged))) {
          throw new Error("the merged document was not written");
        }
        await chmod(merged, 0o640).catch(() => undefined);
        await rm(normalised, { force: true });
        document = merged;
      } catch (error) {
        await options.ledger.updateJob(jobId, "failed", {
          detail: `cover page failed: ${String(error).slice(0, 180)}`,
        });
        return { ok: false, code: 422, reason: "the cover page could not be added to the document" };
      } finally {
        await scratch.cleanup();
      }
    }

    const pages = await countPages(options.run, options.ghostscriptBin, document);
    const sent = await options.run(
      options.sendfaxBin,
      ["-n", "-D", "-f", options.callerId, "-d", to, "-s", `portal job ${jobId}`, document],
      60_000,
    ).catch((error: unknown) => ({ stdout: "", stderr: String(error) }));

    const match = /request id is (\d+)/i.exec(`${sent.stdout}\n${sent.stderr}`);
    if (!match?.[1]) {
      await options.ledger.updateJob(jobId, "failed", { detail: `sendfax: ${sent.stderr.slice(0, 200)}` });
      return { ok: false, code: 502, reason: "the fax server did not accept the job" };
    }

    await options.ledger.updateJob(jobId, "queued", { hylafaxJob: match[1], pages });
    return { ok: true, jobId, hylafaxJob: match[1], pages };
  } finally {
    await rm(quarantined, { force: true });
  }
}

/** Stream to disk while enforcing magic bytes and a hard byte cap. */
async function capture(
  dir: string,
  target: string,
  stream: Readable,
  maxBytes: number,
): Promise<{ code: number; reason: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let written = 0;
  let head = Buffer.alloc(0);
  const out = createWriteStream(target, { mode: 0o600 });

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (head.length < PDF_MAGIC.length) {
        head = Buffer.concat([head, buffer.subarray(0, PDF_MAGIC.length - head.length)]);
        if (head.length >= PDF_MAGIC.length && !head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
          throw new UploadRejected(415, "only PDF documents can be faxed");
        }
      }
      written += buffer.length;
      if (written > maxBytes) {
        throw new UploadRejected(413, `the document is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      if (!out.write(buffer)) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    if (head.length < PDF_MAGIC.length || !head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new UploadRejected(415, "only PDF documents can be faxed");
    }
    return { code: 0, reason: "" };
  } catch (error) {
    out.destroy();
    if (error instanceof UploadRejected) {
      return { code: error.status, reason: error.message };
    }
    return { code: 500, reason: "the upload could not be stored" };
  }
}

class UploadRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}

async function countPages(run: Runner, ghostscriptBin: string, pdf: string): Promise<number> {
  try {
    const result = await run(
      ghostscriptBin,
      ["-q", "-dNODISPLAY", "-dNOSAFER", "-c", `(${pdf}) (r) file runpdfbegin pdfpagecount = quit`],
      20_000,
    );
    const pages = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(pages) && pages > 0 ? pages : 0;
  } catch {
    return 0;
  }
}

/**
 * Remove normalised documents left behind by earlier sends.
 *
 * HylaFAX copies a document into its own queue at submission, so the spool copy
 * is only needed while sendfax runs. It is kept for a day so a failed send can
 * be investigated, then pruned — otherwise the fax server slowly fills its disk
 * with every document ever sent.
 */
export async function pruneSpool(spoolDir: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(spoolDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith("portal-") || !name.endsWith(".pdf")) {
      continue;
    }
    const path = join(spoolDir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      // Already gone, or not ours to remove.
    }
  }
  return removed;
}

/** Pipe a stream into a file — kept for callers that already have a path. */
export async function writeStream(stream: Readable, target: string): Promise<void> {
  await streamPipeline(stream, createWriteStream(target, { mode: 0o600 }));
}
