import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { acceptUpload, type JobLedger, type PipelineOptions, type Runner } from "../src/pipeline.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "latin1");
const NOT_PDF = Buffer.from("<html><script>alert(1)</script></html>", "utf8");

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

class Ledger implements JobLedger {
  readonly states: { status: string; detail?: string; hylafaxJob?: string; pages?: number }[] = [];

  async createJob(): Promise<number> {
    this.states.push({ status: "quarantined" });
    return 7;
  }

  async updateJob(
    _id: number,
    status: "quarantined" | "normalising" | "queued" | "failed",
    patch: { hylafaxJob?: string; detail?: string; pages?: number } = {},
  ): Promise<void> {
    this.states.push({
      status,
      ...(patch.detail === undefined ? {} : { detail: patch.detail }),
      ...(patch.hylafaxJob === undefined ? {} : { hylafaxJob: patch.hylafaxJob }),
      ...(patch.pages === undefined ? {} : { pages: patch.pages }),
    });
  }
}

function fakeRunner(calls: RecordedCall[], options: { sendfaxFails?: boolean } = {}): Runner {
  return async (command, args) => {
    calls.push({ command, args });
    const output = args.find((arg) => arg.startsWith("-sOutputFile="));
    if (output) {
      await writeFile(output.slice("-sOutputFile=".length), "%PDF-1.5\nnormalised", "utf8");
      return { stdout: "", stderr: "" };
    }
    if (args.includes("-dNODISPLAY")) {
      return { stdout: "3\n", stderr: "" };
    }
    if (command.endsWith("sendfax")) {
      if (options.sendfaxFails) {
        return { stdout: "", stderr: "sendfax: Cannot open file" };
      }
      return { stdout: "request id is 42 (1 file)\n", stderr: "" };
    }
    throw new Error(`unexpected command ${command}`);
  };
}

async function setup(overrides: Partial<PipelineOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "fax-pipeline-"));
  const calls: RecordedCall[] = [];
  const ledger = new Ledger();
  const options: PipelineOptions = {
    quarantineDir: join(root, "quarantine"),
    spoolDir: join(root, "spool"),
    callerId: "+15550000000",
    ghostscriptBin: "/usr/bin/gs",
    sendfaxBin: "/usr/sbin/sendfax",
    ledger,
    run: fakeRunner(calls),
    ...overrides,
  };
  return { root, options, calls, ledger };
}

test("a PDF is quarantined, normalised and handed to sendfax", async () => {
  const { options, calls, ledger } = await setup();
  const result = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(PDF),
    filename: "invoice.pdf",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.jobId, 7);
  assert.equal(result.hylafaxJob, "42");
  assert.equal(result.pages, 3);

  assert.deepEqual(
    ledger.states.map((state) => state.status),
    ["quarantined", "normalising", "queued"],
  );
  assert.equal(ledger.states[2]?.hylafaxJob, "42");

  const sendfax = calls.find((call) => call.command.endsWith("sendfax"));
  assert.ok(sendfax, "sendfax was invoked");
  // sendfax must receive the *normalised* document, never the upload.
  const document = sendfax.args[sendfax.args.length - 1] ?? "";
  assert.match(document, /spool\/portal-[0-9a-f-]+\.pdf$/);
  assert.equal(sendfax.args.includes("+15559876543"), true);

  // Ghostscript runs with SAFER and writes to the spool directory.
  const ghostscript = calls.find((call) => call.args.some((arg) => arg.startsWith("-sOutputFile=")));
  assert.ok(ghostscript?.args.includes("-dSAFER"));
});

test("quarantine is emptied again, whatever the outcome", async () => {
  const { options } = await setup();
  await acceptUpload(options, 1, "+15559876543", { stream: Readable.from(PDF), filename: "a.pdf" });
  assert.deepEqual(await readdir(options.quarantineDir), []);
});

test("a non-PDF is refused with 415 and never reaches sendfax", async () => {
  const { options, calls, ledger } = await setup();
  const result = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(NOT_PDF),
    filename: "invoice.pdf",
  });

  assert.deepEqual(result, { ok: false, code: 415, reason: "only PDF documents can be faxed" });
  assert.equal(ledger.states.length, 0);
  assert.equal(calls.some((call) => call.command.endsWith("sendfax")), false);
});

test("a polyglot that starts as HTML is refused even with a PDF extension", async () => {
  const { options } = await setup();
  const polyglot = Buffer.concat([Buffer.from("GIF89a"), PDF]);
  const result = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(polyglot),
    filename: "invoice.pdf",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 415);
});

test("an oversized document is refused with 413", async () => {
  const { options } = await setup({ maxBytes: 32 });
  const result = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(PDF),
    filename: "big.pdf",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 413);
});

test("when sendfax refuses the job it is recorded as failed, not queued", async () => {
  const { root, options, ledger } = await setup();
  const failing: PipelineOptions = { ...options, run: fakeRunner([], { sendfaxFails: true }) };
  const result = await acceptUpload(failing, 1, "+15559876543", {
    stream: Readable.from(PDF),
    filename: "a.pdf",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 502);
  assert.equal(ledger.states.at(-1)?.status, "failed");
  assert.match(ledger.states.at(-1)?.detail ?? "", /Cannot open file/);
  assert.ok(root);
});

test("a cover page is rendered and the merged document is what gets faxed", async () => {
  const { options, calls, ledger } = await setup();
  const withCover = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(PDF),
    filename: "invoice.pdf",
    cover: { title: "Invoice cover", body: "To {{to}} from {{from}}, {{pages}} page(s)" },
  });
  assert.equal(withCover.ok, true);
  if (!withCover.ok) return;

  const ghostscriptCalls = calls.filter((call) => call.command.endsWith("gs"));
  const merged = ghostscriptCalls.find((call) =>
    call.args.filter((arg) => arg.endsWith(".pdf")).length >= 2,
  );
  assert.ok(merged, "cover and document are merged in one Ghostscript run");
  assert.ok(merged.args.some((arg) => arg.includes("cover.pdf")));

  const sendfax = calls.filter((call) => call.command.endsWith("sendfax")).at(-1);
  const document = sendfax?.args[sendfax.args.length - 1] ?? "";
  assert.match(document, /portal-[0-9a-f-]+-cover\.pdf$/, "the merged file is sent, not the bare document");
  assert.equal(ledger.states.at(-1)?.status, "queued");
});

/**
 * The cover is text, so a template cannot smuggle a second PDF or an operator
 * into the spool: it is escaped into PostScript and rendered by Ghostscript.
 */
test("a template's parentheses are escaped before Ghostscript sees them", async () => {
  const { options, calls } = await setup();
  const psWrites: string[] = [];
  const runner: PipelineOptions["run"] = async (command, args, timeoutMs) => {
    if (command.endsWith("gs") && args.some((arg) => arg.endsWith(".ps"))) {
      const source = args[args.length - 1] ?? "";
      psWrites.push(await readFile(source, "latin1"));
    }
    return fakeRunner(calls)(command, args, timeoutMs);
  };

  await acceptUpload(
    { ...options, run: runner },
    1,
    "+15559876543",
    {
      stream: Readable.from(PDF),
      filename: "a.pdf",
      cover: { title: "C", body: "hello) show (evil" },
    },
  );
  assert.equal(psWrites.length, 1);
  assert.ok(psWrites[0]?.includes("hello\\) show \\(evil"), "parens are escaped in the rendered page");
});

test("a failed cover render fails the job rather than quietly sending without it", async () => {
  const { options, ledger } = await setup({
    run: async (command, args) => {
      if (args.some((arg) => arg.endsWith(".ps"))) {
        throw new Error("GPL Ghostscript: cover.pdf not written");
      }
      if (args.some((arg) => arg.startsWith("-sOutputFile="))) {
        const output = args.find((arg) => arg.startsWith("-sOutputFile=")) ?? "";
        await writeFile(output.slice("-sOutputFile=".length), "%PDF-1.5\n", "utf8");
        return { stdout: "", stderr: "" };
      }
      if (command.endsWith("sendfax")) {
        return { stdout: "request id is 42", stderr: "" };
      }
      return { stdout: "2\n", stderr: "" };
    },
  });
  const result = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(PDF),
    filename: "a.pdf",
    cover: { title: "C", body: "x" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 422);
  assert.equal(ledger.states.at(-1)?.status, "failed");
  assert.match(ledger.states.at(-1)?.detail ?? "", /cover page failed/);
});

test("a failed normalisation is reported as 422 and recorded", async () => {
  const { options, ledger } = await setup({
    run: async (command, args) => {
      if (args.some((arg) => arg.startsWith("-sOutputFile="))) {
        return { stdout: "", stderr: "GPL Ghostscript: invalid pdf" };
      }
      if (command.endsWith("sendfax")) {
        return { stdout: "request id is 42", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  const result = await acceptUpload(options, 1, "+15559876543", {
    stream: Readable.from(PDF),
    filename: "broken.pdf",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 422);
  assert.equal(ledger.states.at(-1)?.status, "failed");
});
