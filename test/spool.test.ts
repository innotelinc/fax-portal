import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSpool } from "../src/pipeline.ts";

test("old normalised documents are pruned, current ones are not", async () => {
  const spool = await mkdtemp(join(tmpdir(), "fax-spool-"));
  const stale = join(spool, "portal-old.pdf");
  const fresh = join(spool, "portal-new.pdf");
  const foreign = join(spool, "someone-else.pdf");
  await writeFile(stale, "%PDF-1.4", "utf8");
  await writeFile(fresh, "%PDF-1.4", "utf8");
  await writeFile(foreign, "%PDF-1.4", "utf8");

  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(stale, twoDaysAgo, twoDaysAgo);
  await utimes(foreign, twoDaysAgo, twoDaysAgo);

  assert.equal(await pruneSpool(spool), 1);
  assert.deepEqual((await readdir(spool)).sort(), ["portal-new.pdf", "someone-else.pdf"]);
});

test("pruning a directory that does not exist is not an error", async () => {
  assert.equal(await pruneSpool("/nonexistent/fax-spool"), 0);
});
