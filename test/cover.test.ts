import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coverScratch,
  mergePdfs,
  psEscape,
  renderCoverPdf,
  renderTemplate,
  toPostScript,
  unknownPlaceholders,
} from "../src/cover.ts";
import type { Runner } from "../src/pipeline.ts";

const VARS = { to: "+15559876543", from: "+15550000000", date: "2026-10-26", subject: "invoice.pdf", pages: 3 };

test("placeholders are filled, unknown ones are reported", () => {
  assert.equal(
    renderTemplate("To {{to}} on {{ date }} ({{pages}} pages)", VARS),
    "To +15559876543 on 2026-10-26 (3 pages)",
  );
  assert.deepEqual(unknownPlaceholders("{{to}} {{custom}} {{other}}"), ["custom", "other"]);
  assert.deepEqual(unknownPlaceholders("{{to}} {{pages}}"), []);
  // An unknown placeholder is left alone rather than silently blanked.
  assert.equal(renderTemplate("{{nope}}", VARS), "{{nope}}");
});

test("PostScript strings are escaped, so a template cannot inject operators", () => {
  assert.equal(psEscape("a (b) c\\d"), "a \\(b\\) c\\\\d");
  assert.equal(psEscape("caf\u00e9 \u2014 ok"), "caf? ? ok");
});

test("the rendered page contains the filled template and nothing executable", () => {
  const ps = toPostScript("Invoice cover", "Hello) show 72 72 moveto (evil", VARS);
  // The parens from the template arrive escaped, so they print rather than run.
  assert.ok(ps.includes("(Hello\\) show 72 72 moveto \\(evil) show"), "template parens are escaped");
  assert.equal(ps.includes("\n(Hello) show"), false);
  assert.match(ps, /\(To: \+15559876543\) show/);
  assert.match(ps, /showpage/);
  assert.equal(ps.match(/^%!PS/m)?.length, 1);
});

test("a long line is wrapped instead of running off the page", () => {
  const ps = toPostScript("Cover", "x ".repeat(200), VARS);
  const bodyLines = ps.split("\n").filter((line) => line.startsWith("(x"));
  assert.ok(bodyLines.length > 1, "long text is split across lines");
  for (const line of bodyLines) {
    assert.ok(line.length <= 100, "no line is wider than the page");
  }
});

test("rendering and merging call Ghostscript with the parts in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fax-cover-"));
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    const output = args.find((arg) => arg.startsWith("-sOutputFile="));
    if (output) {
      await writeFile(output.slice("-sOutputFile=".length), "%PDF-1.4\n", "utf8");
    }
    return { stdout: "", stderr: "" };
  };

  const cover = await renderCoverPdf({ run, ghostscriptBin: "/usr/bin/gs" }, "Cover", "Hi {{to}}", VARS, dir);
  assert.equal(cover, join(dir, "cover.pdf"));
  assert.equal(calls[0]?.[0], "/usr/bin/gs");
  assert.ok(calls[0]?.includes("-dSAFER"));

  const target = join(dir, "merged.pdf");
  await mergePdfs({ run, ghostscriptBin: "/usr/bin/gs" }, [cover, join(dir, "doc.pdf")], target);
  const mergeArgs = calls[1] ?? [];
  assert.ok(mergeArgs.includes(cover));
  assert.ok(mergeArgs.includes(join(dir, "doc.pdf")));
  assert.ok(mergeArgs.includes(`-sOutputFile=${target}`));
});

test("the scratch directory is created and removed", async () => {
  const scratch = await coverScratch();
  assert.match(scratch.dir, /fax-cover-/);
  await scratch.cleanup();
});
