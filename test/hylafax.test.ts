import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFaxstatState, parseFaxstat, visibleQueue } from "../src/hylafax.ts";

const SAMPLE = `HylaFAX scheduler on fax.pbx.services: Running
Modem ttyS0 (+15551230001): Running and idle

JID  Pri Snd- Dialogs   Recv-Q Send-Q Local Address           Remote Address        Pages State
 42 127   0       1       0      0 +15551230001           +15559876543              3 Sending job
 41 127   0       1       0      0 +15551230001           +15559870000              1 Done
`;

test("parses queued and finished jobs", () => {
  const jobs = parseFaxstat(SAMPLE);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    jobId: "42",
    from: "+15551230001",
    to: "+15559876543",
    pages: 3,
    state: "Sending job",
  });
  assert.equal(jobs[1]?.state, "Done");
});

test("a terminal state becomes a delivery outcome, in-progress does not", () => {
  assert.equal(classifyFaxstatState("Done"), "sent");
  assert.equal(classifyFaxstatState("done"), "sent");
  assert.equal(classifyFaxstatState("Failed"), "failed");
  assert.equal(classifyFaxstatState("Rejected"), "failed");
  assert.equal(classifyFaxstatState("Cancelled"), "failed");

  // These are retried by faxq, so they are not outcomes yet.
  assert.equal(classifyFaxstatState("Sending job"), "pending");
  assert.equal(classifyFaxstatState("Waiting for modem"), "pending");
  assert.equal(classifyFaxstatState("No answer"), "pending");
  assert.equal(classifyFaxstatState("Busy signal"), "pending");
  assert.equal(classifyFaxstatState("Sleeping"), "pending");
});

test("a client only sees jobs they submitted; an administrator sees all", () => {
  const jobs = parseFaxstat(`HylaFAX scheduler on fax.test: Running
 42 127   0       1       0      0 +15550001 +15559800001 1 Sending job
 43 127   0       1       0      0 +15550001 +15559800002 2 Sending job
`);
  const mine = new Set(["42"]);

  assert.deepEqual(visibleQueue(jobs, mine).map((job) => job.jobId), ["42"]);
  assert.deepEqual(visibleQueue(jobs, mine, true).map((job) => job.jobId), ["42", "43"]);
  assert.deepEqual(visibleQueue(jobs, new Set()).map((job) => job.jobId), []);
});

test("ignores headers, banners and blank lines", () => {
  assert.deepEqual(parseFaxstat(""), []);
  assert.deepEqual(parseFaxstat("HylaFAX scheduler on host: Running\n\n"), []);
});
