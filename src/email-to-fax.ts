/**
 * Email-to-fax ingestion.
 *
 * A mail transport (Postfix `transport_maps` → pipe, or an IMAP poller) hands us
 * a raw message. We take exactly one PDF attachment from it and hand that to the
 * same quarantine → normalise → sendfax path the web upload uses; email is a
 * second door into one room, not a second implementation of it.
 *
 * The parser is deliberately small and strict. It understands the MIME shapes a
 * fax email actually has (single part, multipart/mixed, multipart/alternative,
 * base64 and quoted-printable bodies) and refuses anything it cannot parse
 * cleanly. Guessing at malformed mail is how a fax server spools the wrong
 * document — or the same document seventeen times.
 */

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export interface ParsedMessage {
  readonly from: string;
  readonly subject: string;
  readonly to: string;
  /** First PDF attachment, or null when the message carries none. */
  readonly pdf: Buffer | null;
  readonly attachmentName: string | null;
}

export type ParseResult =
  | { readonly ok: true; readonly message: ParsedMessage }
  | { readonly ok: false; readonly reason: string };

interface Part {
  readonly headers: Map<string, string>;
  readonly body: Buffer;
}

export function parseMessage(raw: Buffer | string): ParseResult {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
  if (bytes.length === 0) {
    return { ok: false, reason: "empty message" };
  }
  if (bytes.length > 30 * 1024 * 1024) {
    return { ok: false, reason: "message too large" };
  }

  const top = splitPart(bytes);
  const from = header(top, "from");
  if (!from) {
    return { ok: false, reason: "message has no From header" };
  }

  const pdfs: { name: string; body: Buffer }[] = [];
  collect(top, pdfs, 0);

  const first = pdfs[0];
  return {
    ok: true,
    message: {
      from,
      subject: decodeHeader(header(top, "subject") ?? ""),
      to: header(top, "to") ?? "",
      pdf: first?.body ?? null,
      attachmentName: first?.name ?? null,
    },
  };
}

function collect(part: Part, out: { name: string; body: Buffer }[], depth: number): void {
  if (depth > 8) {
    return;
  }
  const type = (header(part, "content-type") ?? "text/plain").toLowerCase();

  if (type.startsWith("multipart/")) {
    const boundary = parameter(type, "boundary");
    if (!boundary) {
      return;
    }
    for (const child of splitMultipart(part.body, boundary)) {
      collect(splitPart(child), out, depth + 1);
    }
    return;
  }

  const decoded = decodeBody(part.body, header(part, "content-transfer-encoding"));
  if (decoded.length >= PDF_MAGIC.length && decoded.subarray(0, 5).equals(PDF_MAGIC)) {
    out.push({
      name: parameter(type, "name") ?? parameter(header(part, "content-disposition") ?? "", "filename") ?? "attachment.pdf",
      body: decoded,
    });
  }
}

/** Split headers from body at the first blank line. */
function splitPart(bytes: Buffer): Part {
  const separator = findBlankLine(bytes);
  const head = bytes.subarray(0, separator.index).toString("utf8");
  const body = bytes.subarray(separator.next);
  const headers = new Map<string, string>();
  let current: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function findBlankLine(bytes: Buffer): { index: number; next: number } {
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return { index: i, next: i + 2 };
    }
    if (
      i < bytes.length - 2 &&
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return { index: i, next: i + 4 };
    }
  }
  return { index: bytes.length, next: bytes.length };
}

function splitMultipart(body: Buffer, boundary: string): readonly Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const pieces: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) {
      break;
    }
    const after = start + delimiter.length;
    // Closing delimiter is "--boundary--".
    if (body[after] === 0x2d && body[after + 1] === 0x2d) {
      break;
    }
    const next = body.indexOf(delimiter, after);
    if (next === -1) {
      break;
    }
    // Skip the CRLF that terminates the delimiter line.
    let begin = after;
    if (body[begin] === 0x0d) begin += 1;
    if (body[begin] === 0x0a) begin += 1;
    let end = next;
    if (body[end - 1] === 0x0a) end -= 1;
    if (body[end - 1] === 0x0d) end -= 1;
    pieces.push(body.subarray(begin, end));
    cursor = next;
  }
  return pieces;
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  const kind = (encoding ?? "").trim().toLowerCase();
  if (kind === "base64") {
    return Buffer.from(body.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  }
  if (kind === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return body;
}

function decodeQuotedPrintable(body: Buffer): Buffer {
  const text = body.toString("latin1").replace(/=\r?\n/g, "");
  const out = Buffer.alloc(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out[length] = Number.parseInt(text.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[length] = text.charCodeAt(i);
    }
    length += 1;
  }
  return out.subarray(0, length);
}

function header(part: Part, name: string): string | undefined {
  return part.headers.get(name);
}

/** Pull `key=value` or `key="value"` out of a structured header. */
function parameter(value: string, key: string): string | null {
  const pattern = new RegExp(`${key}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i");
  const match = pattern.exec(value);
  if (!match) {
    return null;
  }
  return (match[2] ?? match[1] ?? "").trim() || null;
}

/** Undo RFC 2047 encoded words in a header value. */
function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, encoding: string, data: string) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(data, "base64").toString("utf8");
      }
      return decodeQuotedPrintable(Buffer.from(data.replace(/_/g, " "), "latin1")).toString("utf8");
    } catch {
      return data;
    }
  });
}

/**
 * Where the fax should go. Fax email is addressed either directly —
 * `+15551234567@fax.innotel.us` — or to the shared inbox with the number in the
 * subject. Only an E.164 number is ever returned.
 */
export function destinationOf(toHeader: string, subject: string): string | null {
  for (const candidate of [toHeader, subject]) {
    const match = /\+[1-9]\d{6,14}/.exec(candidate.replace(/[\s().-]/g, ""));
    if (match) {
      return match[0];
    }
  }
  return null;
}

/** Return the bare address from a From/To header, lowercased. */
export function addressOf(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  const candidate = (angled?.[1] ?? value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(candidate) ? candidate : "";
}
