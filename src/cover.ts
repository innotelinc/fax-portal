import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./pipeline.ts";

/**
 * Cover pages are rendered, never uploaded.
 *
 * A cover page is a template the account owns plus a handful of variables filled
 * from the job. It becomes PostScript, then Ghostscript turns it (and the faxable
 * document) into one PDF, so a customer cannot smuggle a second document into
 * the spool by "editing" a cover page — the only thing a template contributes is
 * text, and text is escaped before it reaches PostScript.
 */

export const PLACEHOLDERS = ["to", "from", "date", "subject", "pages"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface CoverVars {
  readonly to: string;
  readonly from: string;
  readonly date: string;
  readonly subject: string;
  readonly pages: number;
}

export type TemplateVars = CoverVars;

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Placeholders a template uses that the portal does not know. */
export function unknownPlaceholders(body: string): readonly string[] {
  const unknown = new Set<string>();
  for (const match of body.matchAll(TOKEN)) {
    const name = match[1] ?? "";
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      unknown.add(name);
    }
  }
  return [...unknown];
}

export function renderTemplate(body: string, vars: CoverVars): string {
  return body.replace(TOKEN, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      return whole;
    }
    if (name === "pages") {
      return String(vars.pages);
    }
    return vars[name as Exclude<Placeholder, "pages">];
  });
}

/** Printable characters only; PostScript strings are Latin-1 at best. */
export function psEscape(text: string): string {
  return text
    .replace(/[\\()]/g, (match) => `\\${match}`)
    .replace(/[^\x20-\x7E]/g, "?");
}

function wrap(line: string, width = 92): readonly string[] {
  if (line.length <= width) {
    return [line];
  }
  const words = line.split(" ");
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      rows.push(current);
      current = word;
    }
  }
  rows.push(current);
  return rows;
}

/** The cover page as PostScript: a heading, the filled body, a footer. */
export function toPostScript(title: string, body: string, vars: CoverVars): string {
  const lines: string[] = ["%!PS-Adobe-3.0", "%%Pages: 1", "%%BoundingBox: 0 0 612 792", "%%EndComments"];

  lines.push("/Helvetica-Bold findfont 20 scalefont setfont", "72 716 moveto", `(${psEscape(title)}) show`);
  lines.push("/Helvetica findfont 11 scalefont setfont", "72 692 moveto", `(To: ${psEscape(vars.to)}) show`);
  lines.push("72 676 moveto", `(From: ${psEscape(vars.from)}) show`);
  lines.push("72 660 moveto", `(${psEscape(vars.date)} \\267 ${vars.pages} page${vars.pages === 1 ? "" : "s"}) show`);
  lines.push("72 632 moveto 468 0 rlineto stroke");

  let y = 608;
  for (const paragraph of renderTemplate(body, vars).split(/\r?\n/)) {
    for (const row of wrap(paragraph)) {
      if (y < 96) {
        break;
      }
      lines.push("72 " + y + " moveto", `(${psEscape(row)}) show`);
      y -= 15;
    }
    y -= 6;
    if (y < 96) {
      break;
    }
  }

  lines.push("/Helvetica-Oblique findfont 9 scalefont setfont", "72 72 moveto");
  lines.push("(Sent by Innotel Fax \\267 fax.pbx.services) show");
  lines.push("showpage");
  return lines.join("\n");
}

export interface RenderContext {
  readonly run: Runner;
  readonly ghostscriptBin: string;
}

/** Render the cover to a PDF in `dir` and return its path. */
export async function renderCoverPdf(
  context: RenderContext,
  title: string,
  body: string,
  vars: CoverVars,
  dir: string,
): Promise<string> {
  const postscript = toPostScript(title, body, vars);
  const target = join(dir, "cover.pdf");
  const source = join(dir, "cover.ps");
  await writeFile(source, postscript, { encoding: "latin1", mode: 0o600 });
  await context.run(
    context.ghostscriptBin,
    ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", `-sOutputFile=${target}`, source],
    60_000,
  );
  return target;
}

/** Concatenate PDFs in order — the cover becomes page one. */
export async function mergePdfs(context: RenderContext, parts: readonly string[], target: string): Promise<void> {
  await context.run(
    context.ghostscriptBin,
    ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", `-sOutputFile=${target}`, ...parts],
    120_000,
  );
}

/** A scratch directory for cover rendering, removed by the caller. */
export async function coverScratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "fax-cover-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
