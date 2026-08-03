import type { OraFileCitation } from "@workspace/ora-contracts";

/**
 * Phase 8 — Source-Aware Answers (uploaded files).
 *
 * File citations are DERIVED, never model-claimed: we cross-check the final
 * reply text against the file content that was actually injected into the
 * model's context (carriedDocs) and only emit a citation when both sides
 * agree. A citation for a file, slide, or sheet that is not really present in
 * the injected context is therefore impossible by construction — no trailing
 * model-emitted citation block, no streaming-cadence impact, and no way for
 * the model (or a prompt-injecting upload) to fabricate a source.
 *
 * Locator granularity mirrors what the extractors preserve:
 *  - PPTX  → "Slide N:" markers survive extraction  → slide-level citations
 *  - XLSX/CSV → the analyzed sheet name survives    → sheet-level citations
 *  - DOCX/PDF/TXT → flat text (no heading markers)  → file-level citations only
 */

/** Everything we can safely cite for one injected file. */
export interface FileCitationAllowEntry {
  filename: string;
  /** Slide numbers whose content is really present in the injected context. */
  slides: number[];
  /** Sheet names whose content is really present (analyzed sheet only —
   * "other visible sheets" are named but NOT extracted, so citing them would
   * be a fake citation). */
  sheets: string[];
}

const FILE_HEADER = /^File: (.+)$/;
const SLIDE_MARKER = /^Slide (\d{1,4}):/;
const SHEET_ANALYZED = /^Sheet analyzed: (.+?) \(largest visible sheet\)$/;
/** Content delimiter used by buildCarriedDocumentContext. Occurrences inside
 * uploaded content are neutralized with a zero-width space, so a bare `"""`
 * line is always a true block boundary. */
const CONTENT_DELIMITER = '"""';

/**
 * Parse the carried-docs context block into a citation allow-list.
 *
 * Structure produced by buildCarriedDocumentContext:
 *   File: <name>\n[optional blueprint]\n"""\n<content>\n"""
 *
 * `File:` lines INSIDE a content block are ignored (they are file data, not
 * structure), so an uploaded document cannot inject phantom citable files.
 */
export function buildFileCitationAllowList(carriedDocs: string): FileCitationAllowEntry[] {
  if (!carriedDocs || carriedDocs.trim().length === 0) return [];
  const entries: FileCitationAllowEntry[] = [];
  let current: FileCitationAllowEntry | null = null;
  let insideContent = false;

  for (const rawLine of carriedDocs.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === CONTENT_DELIMITER) {
      insideContent = !insideContent;
      continue;
    }
    if (!insideContent) {
      const header = line.match(FILE_HEADER);
      if (header) {
        current = { filename: header[1].trim(), slides: [], sheets: [] };
        entries.push(current);
      }
      continue;
    }
    // Inside a content block: collect locator markers for the current file.
    if (!current) continue;
    const slide = line.match(SLIDE_MARKER);
    if (slide) {
      const n = Number(slide[1]);
      if (Number.isInteger(n) && n > 0 && !current.slides.includes(n)) {
        current.slides.push(n);
      }
      continue;
    }
    const sheet = line.match(SHEET_ANALYZED);
    if (sheet) {
      const name = sheet[1].trim();
      if (name.length > 0 && !current.sheets.includes(name)) {
        current.sheets.push(name);
      }
    }
  }
  return entries.filter((e) => e.filename.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-token containment check for a literal name. */
function replyMentions(reply: string, name: string): boolean {
  if (name.length < 2) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, "iu");
  return pattern.test(reply);
}

/**
 * Whether the reply mentions this file by name. The full filename always
 * counts. The extension-less base name only counts when it is distinctive
 * (contains a digit, separator, or space) — a plain single word never
 * qualifies, otherwise a deck named "presentation.pptx" would be "cited" by
 * every use of the word "presentation". Missing a citation is acceptable;
 * fabricating one is not.
 */
function replyMentionsFile(reply: string, filename: string): boolean {
  if (replyMentions(reply, filename)) return true;
  const base = filename.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  if (base.length === 0 || base === filename) return false;
  const distinctive = /[\d\-_.]|\s/.test(base);
  return distinctive && replyMentions(reply, base);
}

const MAX_FILE_CITATIONS = 10;

/**
 * Derive verified file citations from the final reply.
 *
 * Rules (all requiring the locator to exist in the allow-list):
 *  - "Slide N" mentioned in the reply → slide citation when exactly one
 *    injected file contains that slide, or when the ambiguity is resolved by
 *    the reply also naming one of the candidate files.
 *  - An analyzed sheet name mentioned in the reply → sheet citation with the
 *    same ambiguity rule.
 *  - A file mentioned by name with no finer locator → whole-file citation.
 *    (Suppressed when that file already has slide/sheet citations.)
 */
export function deriveFileCitations(
  reply: string,
  allowList: FileCitationAllowEntry[],
): OraFileCitation[] {
  if (!reply || allowList.length === 0) return [];
  const citations: OraFileCitation[] = [];
  const seen = new Set<string>();
  const push = (c: OraFileCitation) => {
    const key = `${c.file}\u0000${c.locator ?? ""}`;
    if (seen.has(key) || citations.length >= MAX_FILE_CITATIONS) return;
    seen.add(key);
    citations.push(c);
  };

  const mentionedFiles = new Set(
    allowList.filter((e) => replyMentionsFile(reply, e.filename)).map((e) => e.filename),
  );

  // ── Slide citations ──
  const slideMentions = new Set<number>();
  for (const m of reply.matchAll(/\bslide\s+#?(\d{1,4})\b/gi)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) slideMentions.add(n);
  }
  for (const n of [...slideMentions].sort((a, b) => a - b)) {
    const owners = allowList.filter((e) => e.slides.includes(n));
    let owner: FileCitationAllowEntry | undefined;
    if (owners.length === 1) {
      owner = owners[0];
    } else if (owners.length > 1) {
      const named = owners.filter((e) => mentionedFiles.has(e.filename));
      if (named.length === 1) owner = named[0];
    }
    if (owner) {
      push({ file: owner.filename, locator: `Slide ${n}`, kind: "slide" });
    }
  }

  // ── Sheet citations ──
  for (const entry of allowList) {
    for (const sheetName of entry.sheets) {
      if (!replyMentions(reply, sheetName)) continue;
      const owners = allowList.filter((e) => e.sheets.includes(sheetName));
      if (
        owners.length > 1 &&
        !(
          mentionedFiles.has(entry.filename) &&
          owners.filter((e) => mentionedFiles.has(e.filename)).length === 1
        )
      ) {
        continue;
      }
      push({ file: entry.filename, locator: sheetName, kind: "sheet" });
    }
  }

  // ── Whole-file citations (only when no finer locator was cited) ──
  for (const entry of allowList) {
    if (!mentionedFiles.has(entry.filename)) continue;
    const hasLocator = citations.some((c) => c.file === entry.filename);
    if (!hasLocator) push({ file: entry.filename, kind: "file" });
  }

  return citations;
}

/**
 * System-prompt addendum nudging the model to ground answers in the attached
 * file's real structure. This only shapes the VISIBLE reply text ("Slide 3 of
 * deck.pptx says…") — the citation chips themselves are derived
 * deterministically above, so the model cannot fabricate them. Empty when no
 * file content was injected this turn.
 */
export function buildSourceCitationAddendum(carriedDocs: string): string {
  if (!carriedDocs || carriedDocs.trim().length === 0) return "";
  return `\n\n## Source-aware answers
When your answer draws on an attached file, say exactly where the information comes from, using the file's real structure as shown in the attached content: name the file (with its extension, e.g. "report.docx"), and when the content shows slide numbers (e.g. "Slide 3:") or a sheet name, reference that specific slide or sheet (e.g. "Slide 3 of deck.pptx" or "the Revenue sheet in budget.xlsx"). Only reference slides, sheets, sections, or page numbers that actually appear in the attached content — NEVER invent or guess a location, and never cite a sheet whose contents were not extracted. If the attached content has no location markers, refer to the file by name only.`;
}
