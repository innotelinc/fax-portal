import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.ts";

/**
 * The HylaFAX control path, isolated behind one interface.
 *
 * Today AvantFAX shells out to `sendfax` and parses `faxstat`; the portal does
 * exactly the same thing through execFile (never a shell string), so a fax
 * number can never be interpreted as shell syntax. When the HylaFAX REST
 * sidecar lands this is the only file that changes.
 */
export interface QueuedJob {
  readonly jobId: string;
  /** The number being dialled (faxstat's "Remote Address"). */
  readonly to: string;
  /** The local sender identity (faxstat's "Local Address"). */
  readonly from: string;
  readonly pages: number;
  readonly state: string;
}

export interface SendRequest {
  readonly to: string;
  readonly filePath: string;
  readonly callerId: string;
  readonly subject?: string;
}

const run = promisify(execFile);

export class Hylafax {
  constructor(private readonly config: Config) {}

  /** Jobs in the send and done queues, as `faxstat` reports them. */
  async queue(): Promise<readonly QueuedJob[]> {
    let stdout: string;
    try {
      const result = await run(
        `${this.config.hylafax.binDir}/faxstat`,
        ["-s", "-d"],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (error) {
      // An empty queue is not an error; a missing binary is.
      const err = error as NodeJS.ErrnoException & { stdout?: string };
      if (err.code === "ENOENT") {
        throw new Error(`faxstat not found in ${this.config.hylafax.binDir}`);
      }
      stdout = err.stdout ?? "";
    }
    return parseFaxstat(stdout);
  }

  /** Queue a PDF for delivery. Returns the job id HylaFAX assigned. */
  async send(request: SendRequest): Promise<string> {
    const args = [
      "-n", // don't ask for confirmation
      "-D", // the document is already a PDF
      "-f", request.callerId,
      "-d", request.to,
    ];
    if (request.subject) {
      args.push("-s", request.subject);
    }
    args.push(request.filePath);

    const { stdout, stderr } = await run(`${this.config.hylafax.binDir}/sendfax`, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const match = /request id is (\d+)/i.exec(`${stdout}\n${stderr}`);
    if (!match?.[1]) {
      throw new Error(`sendfax returned no request id: ${stderr.trim() || stdout.trim()}`);
    }
    return match[1];
  }
}

export type DeliveryOutcome = "sent" | "failed" | "pending";

/**
 * What a faxstat state means for the sender.
 *
 * Only terminal states count: a job that is "No answer" or "Busy signal" is
 * still in the send queue and will be retried by faxq, so calling it failed
 * would tell the customer their fax was lost when it may still arrive.
 */
export function classifyFaxstatState(state: string): DeliveryOutcome {
  const value = state.trim();
  if (/^(done|sent)\b/i.test(value)) {
    return "sent";
  }
  if (/^(failed|rejected|aborted|cancelled|canceled|blocked|deleted)\b/i.test(value)) {
    return "failed";
  }
  return "pending";
}

/**
 * The queue one caller may see. `faxstat` reports every job on the server, so
 * without this filter a client's inbox would list other customers' fax numbers.
 * An administrator sees the whole queue.
 */
export function visibleQueue(
  jobs: readonly QueuedJob[],
  allowed: ReadonlySet<string>,
  showAll = false,
): readonly QueuedJob[] {
  return showAll ? [...jobs] : jobs.filter((job) => allowed.has(job.jobId));
}

/** Parse `faxstat -s -d` output into jobs. Unknown lines are skipped. */
export function parseFaxstat(output: string): readonly QueuedJob[] {
  const jobs: QueuedJob[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || /^HylaFAX/i.test(line) || /^JID\s/i.test(line)) {
      continue;
    }
    // JID  Pri Snd- Dialogs Recv-Q Send-Q Local-Address Remote-Address Pages State
    const match =
      /^(\d+)\s+(\d+)\s+-?\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    jobs.push({
      jobId: match[1] ?? "",
      from: match[6] ?? "",
      to: match[7] ?? "",
      pages: Number(match[8] ?? 0),
      state: (match[9] ?? "").trim(),
    });
  }
  return jobs;
}
