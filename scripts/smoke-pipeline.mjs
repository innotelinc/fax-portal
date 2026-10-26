#!/usr/bin/env node
/**
 * Smoke test for the send path, on a machine that actually has Ghostscript.
 *
 * The unit tests inject a runner, which proves the logic but not the command
 * line handed to `gs`. This builds a two-page PDF, pushes it through
 * `acceptUpload` against a stub `sendfax`, and checks that what arrives is a
 * normalised PDF in the spool — not the original upload. Run after `npm run
 * build`, on the host that will serve fax.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { acceptUpload } from "../dist/src/pipeline.js";

const exec = promisify(execFile);

function fail(message) {
  console.error(`smoke-pipeline: ${message}`);
  process.exit(1);
}

const root = await mkdtemp(join(tmpdir(), "fax-smoke-"));
const run = async (command, args, timeoutMs) => {
  const { stdout, stderr } = await exec(command, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { stdout, stderr };
};

try {
  const bin = join(root, "bin");
  const spool = join(root, "spool");
  const quarantine = join(root, "quarantine");
  await mkdir(bin, { recursive: true });
  await mkdir(spool, { recursive: true });
  await mkdir(quarantine, { recursive: true });

  const calls = join(root, "sendfax-args.txt");
  const sendfax = join(bin, "sendfax");
  await writeFile(sendfax, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\necho "request id is 4242 (1 file)"\n`, "utf8");
  await chmod(sendfax, 0o755);

  const source = join(root, "source.ps");
  const original = join(root, "invoice.pdf");
  await writeFile(
    source,
    "%!PS\n/Helvetica findfont 20 scalefont setfont\n72 700 moveto (Invoice 42) show showpage\n72 700 moveto (Page two) show showpage\n",
    "utf8",
  );
  await exec("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", `-sOutputFile=${original}`, source]);

  const states = [];
  const ledger = {
    async createJob(job) {
      states.push(`created:${job.sha256.slice(0, 8)}`);
      return 11;
    },
    async updateJob(_id, status, patch = {}) {
      states.push(patch.hylafaxJob ? `${status}:${patch.hylafaxJob}` : status);
    },
  };

  const result = await acceptUpload(
    {
      quarantineDir: quarantine,
      spoolDir: spool,
      callerId: "+15550000000",
      ghostscriptBin: "gs",
      sendfaxBin: sendfax,
      ledger,
      run,
    },
    1,
    "+15559876543",
    { stream: createReadStream(original), filename: "invoice.pdf" },
  );

  if (!result.ok) fail(`upload was refused: ${result.reason} (${result.code})`);
  if (result.hylafaxJob !== "4242") fail(`wrong request id: ${result.hylafaxJob}`);
  if (result.pages !== 2) fail(`expected 2 pages, got ${result.pages}`);

  const args = (await readFile(calls, "utf8")).trim();
  const document = args.split(" ").at(-1);
  if (!document?.startsWith(spool) || !document.endsWith(".pdf")) {
    fail(`sendfax was given ${document}, which is not a spooled PDF`);
  }
  if (document === original) fail("sendfax was handed the original upload");

  const header = (await readFile(document)).subarray(0, 5).toString("latin1");
  if (header !== "%PDF-") fail(`the normalised file is not a PDF (starts ${JSON.stringify(header)})`);

  if ((await readdir(quarantine)).length !== 0) fail("quarantine was not emptied");
  if (!states[0]?.startsWith("created:") || states.slice(1).join(",") !== "normalising,queued:4242") {
    fail(`unexpected ledger transitions: ${states.join(",")}`);
  }

  console.log(`smoke-pipeline: ok — 2-page PDF normalised, queued as 4242, quarantine empty`);
} finally {
  await rm(root, { recursive: true, force: true });
}
