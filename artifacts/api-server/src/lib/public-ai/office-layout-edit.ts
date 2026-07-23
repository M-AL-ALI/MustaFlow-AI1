import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  FILE_OUTPUT_OPERATIONS,
  planUploadedFileRequest,
  type UploadedFileOperation,
} from "./file-edit-planner.js";
import { inferChartsFromTabularData, renderChartPng } from "./file-charts.js";
import { resolveFileEntry } from "./file-context-store.js";
import type { DatasetSummary } from "./dataset-extract.js";
import type { FileFormat, GeneratedFileResult, TabularData } from "./file-builder.js";
import {
  putFileEntry,
  MAX_RAW_BYTES_PER_FILE,
  MAX_TEXT_CHARS_PER_FILE,
  type FileEntry,
} from "./file-store.js";
import type { AiOfficeEditOp } from "./office-ai-edit.js";
import type { OraFileEditQuality } from "@workspace/ora-contracts";
import { logger } from "../logger";

type OfficeRawType = "docx" | "pptx" | "xlsx";

interface LayoutEditInput {
  message: string;
  format: FileFormat;
  documentRefs: string[];
  sessionId: string;
  userId?: string | null;
  subscriptionTier?: string | null;
  /**
   * Phase 5: the multi-file planner's chosen edit target. When set (and it
   * resolves to raw bytes of the requested format), the edit engine operates
   * on THIS file's latest revision head instead of the first ref that matches
   * the format — so "update the Q3 deck" with several uploads edits the right
   * file. Falls back to the ordered scan when it doesn't resolve.
   */
  preferredFileRef?: string | null;
  /**
   * Phase 10: raw bytes of the active working artifact (last generated or
   * edited file in this conversation). When provided, the edit engine targets
   * these bytes directly — no documentRefs lookup needed. The caller is
   * responsible for verifying ownership before populating this field.
   */
  activeAssetBuffer?: Buffer | null;
  /** Display name paired with activeAssetBuffer. Required when buffer is set. */
  activeAssetFileName?: string | null;
}

/**
 * Sentinel fileRef used for synthetic FileEntry objects built from an active
 * asset buffer. The session store is NOT updated for this ref — the route
 * layer handles version chaining via getNextVersionLineageFromAssetId instead.
 */
const ACTIVE_ASSET_FILEREF = "__active_asset__" as const;

type ZipEntries = Record<string, Uint8Array>;

const MIME_BY_TYPE: Record<OfficeRawType, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function safeFileName(name: string, extension: OfficeRawType): string {
  const base =
    name
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-zA-Z0-9._\- ]/g, "_")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80)
      .replace(/^-|-$/g, "") || "ora-edited-file";
  return `${base}-edited.${extension}`;
}

function zipBuffer(entries: ZipEntries): Buffer {
  return Buffer.from(zipSync(entries, { level: 6 }));
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasChartIntent(message: string): boolean {
  return /\b(chart|charts|histogram|dashboard|graph|visuali[sz]e|plot|trend)\b/i.test(message);
}

function hasProfessionalizeIntent(message: string): boolean {
  return /\b(professional|polish|board[-\s]?ready|executive[-\s]?ready|clean(?:er)?|improve|redesign|restyle|reformat|formatting|format|presentation[-\s]?ready)\b/i.test(
    message,
  );
}

function hasSpreadsheetCleanIntent(message: string): boolean {
  return /\b(clean|cleanup|clean\s+up|format|formatting|professional|polish|normalize|tidy|dedupe|deduplicate)\b/i.test(
    message,
  );
}

function targetSlideNumber(message: string): number | null {
  const match = /\bslide\s+(?:number\s*)?(\d{1,3})\b/i.exec(message);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDeleteSlide(message: string): number | null {
  if (!/\b(delete|remove|drop)\b/i.test(message)) return null;
  return targetSlideNumber(message);
}

function parseShortenSlide(message: string): number | null {
  if (!/\b(shorten|condense|summari[sz]e|make\b.{0,40}\bshorter|more concise)\b/i.test(message)) {
    return null;
  }
  return targetSlideNumber(message);
}

interface TextReplacement {
  oldText: string;
  newText: string;
  slideNumber?: number | null;
}

interface SlideTitleChange {
  slideNumber: number;
  newText: string;
}

interface SlideInsertion {
  title: string;
  bodyLines: string[];
  afterSlideNumber?: number | null;
}

interface SlideTextAddition {
  slideNumber: number;
  text: string;
}

interface SlideMove {
  slideNumber: number;
  targetSlideNumber: number;
  placement: "before" | "after";
}

function cleanReplacementSide(value: string): string {
  return normalizePhrase(
    value
      .replace(/\b(?:and\s+)?(?:return|send|give)\s+(?:it|the file|the deck|the document).*$/i, "")
      .replace(/\b(?:in|on)\s+slide\s+\d+.*$/i, "")
      .replace(/^["'“”]+|["'“”.,;:]+$/g, ""),
  );
}

function parseTextReplacement(message: string): TextReplacement | null {
  const slideNumber = targetSlideNumber(message);
  const patterns: Array<(text: string) => RegExpMatchArray | null> = [
    (text) =>
      text.match(
        /\b(?:replace|change|swap)\s+["“]([^"”]{2,160})["”]\s+(?:with|to|into)\s+["“]([^"”]{2,240})["”]/i,
      ),
    (text) =>
      text.match(
        /\b(?:replace|change|swap)\s+(.{2,160}?)\s+(?:with|to|into)\s+(.{2,240}?)(?:$|\s+\b(?:and|then|on|in|return|send|give)\b)/i,
      ),
  ];

  for (const pattern of patterns) {
    const match = pattern(message);
    if (!match) continue;
    const oldText = cleanReplacementSide(match[1] ?? "");
    const newText = cleanReplacementSide(match[2] ?? "");
    if (oldText.length >= 2 && newText.length >= 2) {
      return { oldText, newText, slideNumber };
    }
  }

  const instead = message.match(
    /\b(?:write|put|use)\s+(.{2,240}?)\s+(?:instead of|in place of)\s+(.{2,160}?)(?:$|\s+\b(?:and|then|on|in|return|send|give)\b)/i,
  );
  if (instead) {
    const newText = cleanReplacementSide(instead[1] ?? "");
    const oldText = cleanReplacementSide(instead[2] ?? "");
    if (oldText.length >= 2 && newText.length >= 2) {
      return { oldText, newText, slideNumber };
    }
  }

  return null;
}

const GENERIC_EDIT_TARGET_WORDS = new Set([
  "area",
  "block",
  "column",
  "content",
  "deck",
  "document",
  "field",
  "file",
  "heading",
  "paragraph",
  "powerpoint",
  "section",
  "sheet",
  "slide",
  "spreadsheet",
  "table",
  "text",
  "title",
  "workbook",
]);

function meaningfulTargetKeywords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC_EDIT_TARGET_WORDS.has(word));
}

function parseTextDeletion(message: string): TextReplacement | null {
  if (!/\b(delete|remove|drop|clear)\b/i.test(message)) return null;
  const slideNumber = targetSlideNumber(message);
  const match = message.match(
    /\b(?:delete|remove|drop|clear)\s+(?:the\s+)?(.{2,180}?)(?:\s+(?:from|in|on)\s+(?:slide\s+\d+|the\s+slide|the\s+deck|the\s+document|the\s+file|this|it)\b|\s+\b(?:and|then|return|send|give)\b|[.?!]|$)/i,
  );
  const oldText = cleanReplacementSide(match?.[1] ?? "");
  if (!oldText || /^slide\s+\d+\b/i.test(oldText)) return null;
  if (meaningfulTargetKeywords(oldText).length === 0 && oldText.length < 6) return null;
  return { oldText, newText: "", slideNumber };
}

function parseSlideTitleChange(message: string): SlideTitleChange | null {
  const patterns = [
    /\b(?:change|replace|rename|update|set)\s+(?:the\s+)?(?:title|heading)\s+(?:of|on|for|in)\s+slide\s+(\d{1,3})\s+(?:to|as|with)\s+(.{2,240}?)(?:$|\s+\b(?:and|then|return|send|give)\b)/i,
    /\b(?:change|replace|rename|update|set)\s+slide\s+(\d{1,3})\s+(?:title|heading)\s+(?:to|as|with)\s+(.{2,240}?)(?:$|\s+\b(?:and|then|return|send|give)\b)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const slideNumber = Number.parseInt(match[1] ?? "", 10);
    const newText = cleanReplacementSide(match[2] ?? "");
    if (Number.isFinite(slideNumber) && slideNumber > 0 && newText.length >= 2) {
      return { slideNumber, newText };
    }
  }
  return null;
}

function cleanGeneratedText(value: string): string {
  const cleaned = normalizePhrase(
    value
      .replace(/\b(?:and\s+)?(?:return|send|give)\s+(?:it|the file|the deck|the document).*$/i, "")
      .replace(/^["'\u201c\u201d]+|["'\u201c\u201d.,;:]+$/g, ""),
  );
  return cleaned.replace(/^(?:called|named|titled|content|text)\s+/i, "");
}

function parseSlideInsertion(message: string): SlideInsertion | null {
  if (!/\b(add|insert|create|make)\b/i.test(message) || !/\bslide\b/i.test(message)) {
    return null;
  }
  const afterMatch = /\bafter\s+slide\s+(\d{1,3})\b/i.exec(message);
  const titleMatch =
    /\b(?:title|titled|called|named|about)\s+["â€œ]?(.{2,180}?)(?:["â€]|\s+\b(?:with|and|then|after|before|return|send|give)\b|$)/i.exec(
      message,
    ) ??
    /\bslide\s+(?:for|about)\s+["â€œ]?(.{2,180}?)(?:["â€]|\s+\b(?:with|and|then|after|before|return|send|give)\b|$)/i.exec(
      message,
    );
  const bodyMatch =
    /\b(?:with|include|add)\s+(?:bullets?|content|text)\s+["â€œ]?(.{2,260}?)(?:["â€]|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    );
  const title = cleanGeneratedText(titleMatch?.[1] ?? "New Slide");
  const body = cleanGeneratedText(bodyMatch?.[1] ?? "");
  return {
    title: title || "New Slide",
    bodyLines: body
      ? body
          .split(/\s*(?:;|\n|\u2022|\s+-\s+)\s*/)
          .map(cleanGeneratedText)
          .filter(Boolean)
          .slice(0, 6)
      : [],
    afterSlideNumber: afterMatch ? Number.parseInt(afterMatch[1]!, 10) : null,
  };
}

function parseSlideTextAddition(message: string): SlideTextAddition | null {
  if (!/\b(add|append|insert|include|put)\b/i.test(message)) return null;
  const slideNumber = targetSlideNumber(message);
  if (!slideNumber) return null;
  const textMatch =
    /\b(?:add|append|insert|include|put)\s+(?:a\s+)?(?:bullet|note|text|line|point)\s+["â€œ]?(.{2,240}?)(?:["â€]|\s+\b(?:to|on|in)\s+slide\s+\d+|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    ) ??
    /\b(?:to|on|in)\s+slide\s+\d+\s+(?:add|append|insert|include|put)\s+["â€œ]?(.{2,240}?)(?:["â€]|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    );
  const text = cleanGeneratedText(textMatch?.[1] ?? "");
  return text ? { slideNumber, text } : null;
}

function parseSlideMove(message: string): SlideMove | null {
  if (!/\b(move|reorder|rearrange|shift)\b/i.test(message) || !/\bslide\b/i.test(message)) {
    return null;
  }
  const match =
    /\b(?:move|reorder|rearrange|shift)\s+slide\s+(\d{1,3})\s+(before|after)\s+slide\s+(\d{1,3})\b/i.exec(
      message,
    );
  if (!match) return null;
  const slideNumber = Number.parseInt(match[1]!, 10);
  const targetSlideNumber = Number.parseInt(match[3]!, 10);
  if (!Number.isFinite(slideNumber) || !Number.isFinite(targetSlideNumber)) return null;
  return {
    slideNumber,
    placement: match[2]!.toLowerCase() === "before" ? "before" : "after",
    targetSlideNumber,
  };
}

function parseDeleteColumn(message: string): string | null {
  if (!/\b(delete|remove|drop)\b/i.test(message) || !/\b(column|field)\b/i.test(message)) {
    return null;
  }
  const patterns = [
    /\b(?:delete|remove|drop)\s+(?:the\s+)?(?:column|field)\s+["“]?([^"”.,;!?]{2,100})["”]?/i,
    /\b(?:delete|remove|drop)\s+["“]?([^"”.,;!?]{2,100})["”]?\s+(?:column|field)\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const target = cleanReplacementSide(match?.[1] ?? "");
    if (target && meaningfulTargetKeywords(target).length > 0) return target;
  }
  return null;
}

function parseAddColumn(message: string): string | null {
  if (!/\b(add|insert|create)\b/i.test(message) || !/\b(column|field)\b/i.test(message)) {
    return null;
  }
  const patterns = [
    /\b(?:add|insert|create)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:column|field)\s+(?:called|named|for)?\s*["â€œ]?([^"â€.,;!?]{2,80})["â€]?/i,
    /\b(?:add|insert|create)\s+["â€œ]?([^"â€.,;!?]{2,80})["â€]?\s+(?:column|field)\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const target = cleanReplacementSide(match?.[1] ?? "").replace(/^(?:a|an|the|new)\s+/i, "");
    if (target && meaningfulTargetKeywords(target).length > 0) return target;
  }
  return null;
}

function parseAddRow(message: string): string[] | null {
  if (!/\b(add|insert|append)\b/i.test(message) || !/\b(row|record)\b/i.test(message)) return null;
  const match =
    /\b(?:add|insert|append)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:row|record)\s+(?:with|for)?\s*["â€œ]?(.{2,240}?)(?:["â€]|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    );
  const raw = cleanGeneratedText(match?.[1] ?? "");
  if (!raw) return null;
  const values = raw
    .split(/\s*(?:,|;|\|)\s*/)
    .map(cleanGeneratedText)
    .filter(Boolean)
    .slice(0, 50);
  return values.length > 0 ? values : null;
}

function parseAddSheetName(message: string): string | null {
  if (!/\b(add|insert|create)\b/i.test(message) || !/\b(sheet|worksheet|tab)\b/i.test(message)) {
    return null;
  }
  const match =
    /\b(?:add|insert|create)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:sheet|worksheet|tab)\s+(?:called|named|for)?\s*["â€œ]?([^"â€.,;!?]{2,80})["â€]?/i.exec(
      message,
    ) ??
    /\b(?:sheet|worksheet|tab)\s+(?:called|named)\s+["â€œ]?([^"â€.,;!?]{2,80})["â€]?/i.exec(
      message,
    );
  const name = cleanReplacementSide(match?.[1] ?? "");
  return name ? name.slice(0, 31) : null;
}

function parseRenameSheet(message: string): { oldName?: string; newName: string } | null {
  if (
    !/\b(rename|retitle|change)\b/i.test(message) ||
    !/\b(sheet|worksheet|tab)\b/i.test(message)
  ) {
    return null;
  }
  const explicit =
    /\b(?:rename|retitle|change)\s+(?:the\s+)?(?:sheet|worksheet|tab)\s+["â€œ]?([^"â€,]{2,80})["â€]?\s+(?:to|as)\s+["â€œ]?(.{2,80}?)(?:["â€]|,|\s+\b(?:and|then|sort|dedupe|return|send|give)\b|$)/i.exec(
      message,
    );
  if (explicit) {
    const oldName = cleanReplacementSide(explicit[1] ?? "");
    const newName = cleanGeneratedText(explicit[2] ?? "").slice(0, 31);
    return newName ? { oldName, newName } : null;
  }
  const simple =
    /\b(?:rename|retitle|change)\s+(?:the\s+)?(?:sheet|worksheet|tab)\s+(?:to|as)\s+["â€œ]?(.{2,80}?)(?:["â€]|,|\s+\b(?:and|then|sort|dedupe|return|send|give)\b|$)/i.exec(
      message,
    );
  const newName = cleanGeneratedText(simple?.[1] ?? "").slice(0, 31);
  return newName ? { newName } : null;
}

function parseSortColumn(message: string): string | null {
  if (!/\b(sort|order)\b/i.test(message)) return null;
  const match =
    /\b(?:sort|order)\s+(?:by|on)\s+(?:the\s+)?(?:column\s+)?["â€œ]?([^"â€.,;!?]{2,80})["â€]?/i.exec(
      message,
    ) ??
    /\b(?:sort|order)\s+(?:the\s+)?(?:sheet|workbook|spreadsheet)\s+by\s+["â€œ]?([^"â€.,;!?]{2,80})["â€]?/i.exec(
      message,
    );
  const target = cleanReplacementSide(match?.[1] ?? "");
  return target && meaningfulTargetKeywords(target).length > 0 ? target : null;
}

function shortenText(value: string): string | null {
  const clean = normalizePhrase(value);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 12 && clean.length < 90) return null;
  const shortened = words.slice(0, 18).join(" ");
  return shortened.length < clean.length ? `${shortened}...` : null;
}

function professionalizeText(value: string): string | null {
  const clean = normalizePhrase(value)
    .replace(/\bvery\s+very\b/gi, "very")
    .replace(/\b(?:basically|really|kind of|sort of)\b/gi, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;

  const shortened = shortenText(clean) ?? clean;
  const isLikelyHeading = shortened.length <= 80 && shortened.split(/\s+/).length <= 9;
  const polished = isLikelyHeading
    ? shortened.replace(/\b\w+/g, (word) =>
        /^[A-Z0-9]{2,}$/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
      )
    : shortened.replace(/\s+([,.;:!?])/g, "$1");

  return polished !== value ? polished : null;
}

function replaceTextNodes(
  xml: string,
  nodeName: "a:t" | "w:t",
  replacement: TextReplacement,
): { xml: string; count: number } {
  const oldNorm = normalizePhrase(replacement.oldText);
  const oldRegex = new RegExp(escapeRegExp(oldNorm), "i");
  const keywords = meaningfulTargetKeywords(oldNorm);
  let count = 0;
  const tag = escapeRegExp(nodeName);
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`, "g");
  const nextXml = xml.replace(re, (full, open: string, inner: string, close: string) => {
    const text = xmlUnescape(inner);
    const normalizedText = normalizePhrase(text);
    if (oldRegex.test(normalizedText)) {
      count += 1;
      const replaced = text.replace(
        new RegExp(escapeRegExp(replacement.oldText), "gi"),
        replacement.newText,
      );
      if (replaced === text) return `${open}${xmlEscape(replacement.newText)}${close}`;
      return `${open}${xmlEscape(replaced)}${close}`;
    }
    if (
      keywords.length > 0 &&
      keywords.every((word) => normalizedText.toLowerCase().includes(word))
    ) {
      count += 1;
      return `${open}${xmlEscape(replacement.newText)}${close}`;
    }
    return full;
  });
  return { xml: nextXml, count };
}

/**
 * Build a forgiving matcher for an AI-planned "find" passage: whitespace runs
 * collapse to `\s+` and straight/curly quote variants match each other, since
 * models routinely normalize the typographic quotes and spacing that Office
 * documents actually contain. The find text itself is regex-escaped.
 */
function looseFindRegex(find: string): RegExp {
  const parts = normalizePhrase(find)
    .split(" ")
    .filter(Boolean)
    .map((word) =>
      escapeRegExp(word)
        .replace(/['\u2018\u2019]/g, "['\u2018\u2019]")
        .replace(/["\u201C\u201D]/g, '["\u201C\u201D]'),
    );
  return new RegExp(parts.join("\\s+"), "gi");
}

/**
 * Apply AI-planned find→replace operations to every `<a:t>`/`<w:t>` text node
 * in an OOXML part. Matching is per-node (a passage split across runs will not
 * match — callers treat "0 ops applied" honestly instead of regenerating).
 * Returns the indexes of the ops that changed at least one node.
 *
 * Runs paragraph-by-paragraph so paragraphs containing field codes are never
 * touched (rewriting runs inside field boundaries corrupts them). Ops whose
 * replacement contains "\n" are deliberately left to the paragraph pass, which
 * knows how to expand newlines (cloned `a:p` bullets for pptx, `<w:br/>`
 * segments for docx) — applying them here would drop raw newline characters
 * into a single text node.
 */
function applyAiOpsToXmlNodes(
  xml: string,
  nodeName: "a:t" | "w:t",
  ops: AiOfficeEditOp[],
): { xml: string; appliedOps: Set<number> } {
  const tag = escapeRegExp(nodeName);
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`, "g");
  const paraTag = nodeName === "a:t" ? "a:p" : "w:p";
  const paraRe = new RegExp(`<${paraTag}\\b[\\s\\S]*?</${paraTag}>`, "g");
  const fieldRe = nodeName === "w:t" ? /<w:fldChar\b|<w:instrText\b/ : /<a:fld\b/;
  const regexes = ops.map((op) => looseFindRegex(op.find));
  const appliedOps = new Set<number>();
  const applyToNodes = (chunk: string): string =>
    chunk.replace(re, (full, open: string, inner: string, close: string) => {
      let text = xmlUnescape(inner);
      let changed = false;
      ops.forEach((op, i) => {
        if (op.replace.includes("\n")) return;
        const rx = regexes[i]!;
        rx.lastIndex = 0;
        if (!rx.test(text)) return;
        rx.lastIndex = 0;
        // Replacer function so `$` sequences in the replacement stay literal.
        text = text.replace(rx, () => op.replace);
        appliedOps.add(i);
        changed = true;
      });
      if (!changed) return full;
      return `${open}${xmlEscape(text)}${close}`;
    });
  // Walk paragraphs (field-guarded) and the gaps between them (plain edits),
  // so text nodes outside any paragraph are still handled.
  let out = "";
  let last = 0;
  for (const m of xml.matchAll(paraRe)) {
    const paraXml = m[0];
    out += applyToNodes(xml.slice(last, m.index));
    out += fieldRe.test(paraXml) ? paraXml : applyToNodes(paraXml);
    last = m.index + paraXml.length;
  }
  out += applyToNodes(xml.slice(last));
  return { xml: out, appliedOps };
}

/**
 * Rewrite a paragraph's text nodes so the FIRST node carries `newText` (keeping
 * that run's formatting) and every later node is blanked (keeping its run shell
 * so the XML stays valid). For docx, "\n" inside `newText` becomes `<w:br/>`
 * segments within the same run.
 */
function rewriteParagraphTextNodes(
  paraXml: string,
  nodeName: "a:t" | "w:t",
  newText: string,
): string {
  const tag = escapeRegExp(nodeName);
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`, "g");
  let first = true;
  return paraXml.replace(re, (_full, open: string, _inner: string, close: string) => {
    if (!first) return `${open}${close}`;
    first = false;
    if (nodeName === "w:t" && newText.includes("\n")) {
      const lines = newText.split("\n");
      const headOpen = open.includes("xml:space")
        ? open
        : open.replace(/<w:t\b/, '<w:t xml:space="preserve"');
      const rest = lines
        .slice(1)
        .map((line) => `<w:br/><w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
        .join("");
      return `${headOpen}${xmlEscape(lines[0] ?? "")}${close}${rest}`;
    }
    return `${open}${xmlEscape(newText)}${close}`;
  });
}

/**
 * Paragraph-level fallback pass: real Office files fragment sentences across
 * many text runs (spellcheck/formatting splits), so a multi-word "find" that
 * fails per-node is retried here against each paragraph's JOINED run text.
 * On a match the replacement is written into the paragraph's first run (the
 * surrounding unmatched prefix/suffix of the joined text is preserved).
 * Paragraphs containing field codes are skipped — blanking runs inside field
 * boundaries corrupts them. For pptx, "\n" in the result clones the matched
 * `a:p` (with its `a:pPr`) once per extra line, i.e. new bullets.
 */
function applyAiOpsToParagraphs(
  xml: string,
  nodeName: "a:t" | "w:t",
  ops: AiOfficeEditOp[],
  opIndexes: number[],
): { xml: string; appliedOps: Set<number> } {
  const paraTag = nodeName === "a:t" ? "a:p" : "w:p";
  const paraRe = new RegExp(`<${paraTag}\\b[\\s\\S]*?</${paraTag}>`, "g");
  const fieldRe = nodeName === "w:t" ? /<w:fldChar\b|<w:instrText\b/ : /<a:fld\b/;
  const textRe = new RegExp(
    `<${escapeRegExp(nodeName)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(nodeName)}>`,
    "g",
  );
  const regexes = ops.map((op) => looseFindRegex(op.find));
  const appliedOps = new Set<number>();

  const nextXml = xml.replace(paraRe, (paraXml) => {
    if (fieldRe.test(paraXml)) return paraXml;
    const joined = [...paraXml.matchAll(textRe)].map((m) => xmlUnescape(m[1] ?? "")).join("");
    if (!joined.trim()) return paraXml;
    let text = joined;
    let changed = false;
    for (const i of opIndexes) {
      const rx = regexes[i]!;
      rx.lastIndex = 0;
      if (!rx.test(text)) continue;
      rx.lastIndex = 0;
      text = text.replace(rx, () => ops[i]!.replace);
      appliedOps.add(i);
      changed = true;
    }
    if (!changed) return paraXml;
    if (nodeName === "a:t" && text.includes("\n")) {
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const [firstLine, ...restLines] = lines.length > 0 ? lines : [""];
      return [firstLine ?? "", ...restLines]
        .map((line) => rewriteParagraphTextNodes(paraXml, nodeName, line))
        .join("");
    }
    return rewriteParagraphTextNodes(paraXml, nodeName, text);
  });
  return { xml: nextXml, appliedOps };
}

/**
 * Apply AI-planned text operations to the raw Office bytes, preserving all
 * layout/styling. Returns the edited buffer plus how many DISTINCT ops landed;
 * null when the file cannot be processed at all.
 */
async function applyAiOfficeEditOps(
  entry: FileEntry,
  type: OfficeRawType,
  ops: AiOfficeEditOp[],
): Promise<{ buffer: Buffer; appliedCount: number; appliedIndices: number[] } | null> {
  const raw = base64Raw(entry);
  if (!raw || ops.length === 0) return null;

  if (type === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(raw as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const regexes = ops.map((op) => looseFindRegex(op.find));
    const appliedOps = new Set<number>();
    workbook.eachSheet((sheet) => {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const value = cell.value;
          if (typeof value !== "string") return;
          let text = value;
          let changed = false;
          ops.forEach((op, i) => {
            const rx = regexes[i]!;
            rx.lastIndex = 0;
            if (!rx.test(text)) return;
            rx.lastIndex = 0;
            text = text.replace(rx, () => op.replace);
            appliedOps.add(i);
            changed = true;
          });
          if (changed) cell.value = text;
        });
      });
    });
    if (appliedOps.size === 0) return null;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      appliedCount: appliedOps.size,
      appliedIndices: [...appliedOps].sort((a, b) => a - b),
    };
  }

  const entries = unzipSync(new Uint8Array(raw));
  const appliedOps = new Set<number>();
  if (type === "docx") {
    const docXml = getXml(entries, "word/document.xml");
    if (!docXml) return null;
    // Pass 1: per-node (preserves per-run formatting when the find sits in one run).
    const nodePass = applyAiOpsToXmlNodes(docXml, "w:t", ops);
    nodePass.appliedOps.forEach((i) => appliedOps.add(i));
    let currentXml = nodePass.xml;
    // Pass 2: paragraph-level for ops the node pass could not locate.
    const remaining = ops.map((_, i) => i).filter((i) => !appliedOps.has(i));
    if (remaining.length > 0) {
      const paraPass = applyAiOpsToParagraphs(currentXml, "w:t", ops, remaining);
      paraPass.appliedOps.forEach((i) => appliedOps.add(i));
      currentXml = paraPass.xml;
    }
    if (appliedOps.size > 0) setXml(entries, "word/document.xml", currentXml);
  } else {
    const slidePaths = Object.keys(entries).filter((path) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(path),
    );
    const slideXmls = new Map<string, string>();
    for (const path of slidePaths) {
      const slideXml = getXml(entries, path);
      if (slideXml) slideXmls.set(path, slideXml);
    }
    const changedPaths = new Set<string>();
    // Pass 1: per-node across all slides.
    for (const [path, slideXml] of slideXmls) {
      const updated = applyAiOpsToXmlNodes(slideXml, "a:t", ops);
      if (updated.appliedOps.size > 0) {
        updated.appliedOps.forEach((i) => appliedOps.add(i));
        slideXmls.set(path, updated.xml);
        changedPaths.add(path);
      }
    }
    // Pass 2: paragraph-level (joined run text) for ops still unapplied.
    const remaining = ops.map((_, i) => i).filter((i) => !appliedOps.has(i));
    if (remaining.length > 0) {
      for (const [path, slideXml] of slideXmls) {
        const updated = applyAiOpsToParagraphs(slideXml, "a:t", ops, remaining);
        if (updated.appliedOps.size > 0) {
          updated.appliedOps.forEach((i) => appliedOps.add(i));
          slideXmls.set(path, updated.xml);
          changedPaths.add(path);
        }
      }
    }
    for (const path of changedPaths) setXml(entries, path, slideXmls.get(path)!);
  }
  if (appliedOps.size === 0) return null;
  return {
    buffer: zipBuffer(entries),
    appliedCount: appliedOps.size,
    appliedIndices: [...appliedOps].sort((a, b) => a - b),
  };
}

function professionalizeTextNodes(
  xml: string,
  nodeName: "a:t" | "w:t",
): { xml: string; count: number } {
  let count = 0;
  const tag = escapeRegExp(nodeName);
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`, "g");
  const nextXml = xml.replace(re, (full, open: string, inner: string, close: string) => {
    const next = professionalizeText(xmlUnescape(inner));
    if (!next) return full;
    count += 1;
    return `${open}${xmlEscape(next)}${close}`;
  });
  return { xml: nextXml, count };
}

function shortenTextNodes(xml: string): { xml: string; count: number } {
  let count = 0;
  const nextXml = xml.replace(/(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)/g, (full, open, inner, close) => {
    const shortened = shortenText(xmlUnescape(inner));
    if (!shortened) return full;
    count += 1;
    return `${open}${xmlEscape(shortened)}${close}`;
  });
  return { xml: nextXml, count };
}

function getXml(entries: ZipEntries, path: string): string | null {
  const bytes = entries[path];
  return bytes ? strFromU8(bytes) : null;
}

function setXml(entries: ZipEntries, path: string, xml: string): void {
  entries[path] = strToU8(xml);
}

function pathDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function pathBase(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

interface Relationship {
  id: string;
  target: string;
  tag: string;
}

function presentationRelationships(entries: ZipEntries): Relationship[] {
  const relsXml = getXml(entries, "ppt/_rels/presentation.xml.rels");
  if (!relsXml) return [];
  const relationships: Relationship[] = [];
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const tag = match[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) relationships.push({ id, target, tag });
  }
  return relationships;
}

function normalizeSlideTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  if (target.startsWith("ppt/")) return target;
  return `ppt/${target.replace(/^\.\//, "")}`;
}

function slideOrder(entries: ZipEntries): Array<{ rId: string; path: string }> {
  const presentationXml = getXml(entries, "ppt/presentation.xml");
  if (!presentationXml) return [];
  const rels = presentationRelationships(entries);
  const byId = new Map(rels.map((rel) => [rel.id, normalizeSlideTarget(rel.target)]));
  const slides: Array<{ rId: string; path: string }> = [];
  for (const match of presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?>/g)) {
    const rId = match[1]!;
    const path = byId.get(rId);
    if (path) slides.push({ rId, path });
  }
  return slides;
}

function removeContentTypeOverride(entries: ZipEntries, partName: string): void {
  const contentTypes = getXml(entries, "[Content_Types].xml");
  if (!contentTypes) return;
  const escaped = escapeRegExp(partName.startsWith("/") ? partName : `/${partName}`);
  setXml(
    entries,
    "[Content_Types].xml",
    contentTypes.replace(
      new RegExp(`<Override\\b(?=[^>]*\\bPartName="${escaped}")[^>]*/>\\s*`, "g"),
      "",
    ),
  );
}

function addContentTypeOverride(entries: ZipEntries, partName: string, contentType: string): void {
  const contentTypes = getXml(entries, "[Content_Types].xml");
  if (!contentTypes) return;
  const normalized = partName.startsWith("/") ? partName : `/${partName}`;
  if (contentTypes.includes(`PartName="${normalized}"`)) return;
  setXml(
    entries,
    "[Content_Types].xml",
    contentTypes.replace(
      "</Types>",
      `<Override PartName="${xmlEscape(normalized)}" ContentType="${xmlEscape(contentType)}"/></Types>`,
    ),
  );
}

function nextSlidePartNumber(entries: ZipEntries): number {
  let max = 0;
  for (const path of Object.keys(entries)) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(path);
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

function nextPresentationRelationshipId(relsXml: string): string {
  let max = 0;
  for (const match of relsXml.matchAll(/\bId="rId(\d+)"/g)) {
    max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return `rId${max + 1}`;
}

function nextPresentationSlideId(presentationXml: string): number {
  let max = 255;
  for (const match of presentationXml.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)) {
    max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

function deletePptxSlide(entries: ZipEntries, slideNumber: number): number {
  const slides = slideOrder(entries);
  const target = slides[slideNumber - 1];
  if (!target) return 0;

  const presentationXml = getXml(entries, "ppt/presentation.xml");
  const relsXml = getXml(entries, "ppt/_rels/presentation.xml.rels");
  if (!presentationXml || !relsXml) return 0;

  setXml(
    entries,
    "ppt/presentation.xml",
    presentationXml.replace(
      new RegExp(`<p:sldId\\b(?=[^>]*\\br:id="${escapeRegExp(target.rId)}")[^>]*/>\\s*`, "g"),
      "",
    ),
  );
  setXml(
    entries,
    "ppt/_rels/presentation.xml.rels",
    relsXml.replace(
      new RegExp(`<Relationship\\b(?=[^>]*\\bId="${escapeRegExp(target.rId)}")[^>]*/>\\s*`, "g"),
      "",
    ),
  );

  delete entries[target.path];
  const relPath = `${pathDir(target.path)}/_rels/${pathBase(target.path)}.rels`;
  delete entries[relPath];
  removeContentTypeOverride(entries, target.path);
  return 1;
}

function movePptxSlide(entries: ZipEntries, move: SlideMove): number {
  const slides = slideOrder(entries);
  const fromIndex = move.slideNumber - 1;
  const targetIndex = move.targetSlideNumber - 1;
  if (
    fromIndex < 0 ||
    targetIndex < 0 ||
    fromIndex >= slides.length ||
    targetIndex >= slides.length
  ) {
    return 0;
  }
  if (fromIndex === targetIndex) return 0;
  const presentationXml = getXml(entries, "ppt/presentation.xml");
  if (!presentationXml) return 0;

  const slideTags = Array.from(
    presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?>/g),
  ).map((match) => ({ rId: match[1]!, tag: match[0] }));
  const moving = slideTags.splice(fromIndex, 1)[0];
  if (!moving) return 0;
  const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertAt = move.placement === "before" ? adjustedTarget : adjustedTarget + 1;
  slideTags.splice(Math.max(0, Math.min(insertAt, slideTags.length)), 0, moving);

  const nextList = slideTags.map((slide) => slide.tag).join("");
  setXml(
    entries,
    "ppt/presentation.xml",
    presentationXml.replace(
      /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
      `<p:sldIdLst>${nextList}</p:sldIdLst>`,
    ),
  );
  return 1;
}

function replaceSlideTextForInsertedSlide(xml: string, insertion: SlideInsertion): string {
  let index = 0;
  const bodyLines =
    insertion.bodyLines.length > 0 ? insertion.bodyLines : ["Add supporting details here."];
  const bodyText = bodyLines.join("\n");
  const updated = xml.replace(
    /(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)/g,
    (full, open: string, _inner: string, close: string) => {
      const next =
        index === 0
          ? insertion.title
          : index === 1
            ? bodyText
            : (bodyLines[Math.min(index - 1, bodyLines.length - 1)] ?? bodyText);
      index += 1;
      return open + xmlEscape(next) + close;
    },
  );
  if (index > 1 || !bodyText) return updated;
  const bodyParagraphs = bodyLines
    .map((line) => `<a:p><a:r><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`)
    .join("");
  const bodyShape =
    '<p:sp><p:nvSpPr><p:cNvPr id="1000" name="Ora Generated Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
    bodyParagraphs +
    "</p:txBody></p:sp>";
  return updated.includes("</p:spTree>")
    ? updated.replace("</p:spTree>", `${bodyShape}</p:spTree>`)
    : updated;
}

function insertPptxSlide(entries: ZipEntries, insertion: SlideInsertion): number {
  const slides = slideOrder(entries);
  const template =
    slides[
      Math.max(0, Math.min((insertion.afterSlideNumber ?? slides.length) - 1, slides.length - 1))
    ];
  const presentationXml = getXml(entries, "ppt/presentation.xml");
  const relsXml = getXml(entries, "ppt/_rels/presentation.xml.rels");
  if (!template || !presentationXml || !relsXml) return 0;
  const templateXml = getXml(entries, template.path);
  if (!templateXml) return 0;

  const nextPartNumber = nextSlidePartNumber(entries);
  const nextPath = `ppt/slides/slide${nextPartNumber}.xml`;
  const nextRelPath = `ppt/slides/_rels/slide${nextPartNumber}.xml.rels`;
  const templateRelPath = `${pathDir(template.path)}/_rels/${pathBase(template.path)}.rels`;
  const nextRId = nextPresentationRelationshipId(relsXml);
  const nextSlideId = nextPresentationSlideId(presentationXml);
  const nextSlideXml = replaceSlideTextForInsertedSlide(templateXml, insertion);

  setXml(entries, nextPath, nextSlideXml);
  if (entries[templateRelPath]) {
    entries[nextRelPath] = new Uint8Array(entries[templateRelPath]!);
  }
  addContentTypeOverride(
    entries,
    nextPath,
    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  );

  const relTag = `<Relationship Id="${nextRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${nextPartNumber}.xml"/>`;
  setXml(
    entries,
    "ppt/_rels/presentation.xml.rels",
    relsXml.replace("</Relationships>", `${relTag}</Relationships>`),
  );

  const insertTag = `<p:sldId id="${nextSlideId}" r:id="${nextRId}"/>`;
  const slideTags = Array.from(
    presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?>/g),
  ).map((match) => ({ rId: match[1]!, tag: match[0] }));
  const insertIndex = Math.max(
    0,
    Math.min(insertion.afterSlideNumber ?? slides.length, slideTags.length),
  );
  slideTags.splice(insertIndex, 0, { rId: nextRId, tag: insertTag });
  const nextList = slideTags.map((slide) => slide.tag).join("");
  setXml(
    entries,
    "ppt/presentation.xml",
    presentationXml.replace(
      /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
      `<p:sldIdLst>${nextList}</p:sldIdLst>`,
    ),
  );
  return 1;
}

function addPptxTextToSlide(entries: ZipEntries, addition: SlideTextAddition): number {
  const slide = slideOrder(entries)[addition.slideNumber - 1];
  if (!slide) return 0;
  const xml = getXml(entries, slide.path);
  if (!xml) return 0;
  let changed = false;
  const updated = xml.replace(
    /(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)(?![\s\S]*<a:t\b)/,
    (full, open: string, inner: string, close: string) => {
      changed = true;
      const text = xmlUnescape(inner);
      const next = text ? `${text}\n${addition.text}` : addition.text;
      return `${open}${xmlEscape(next)}${close}`;
    },
  );
  if (!changed) return 0;
  setXml(entries, slide.path, updated);
  return 1;
}

function replacePptxText(entries: ZipEntries, replacement: TextReplacement): number {
  const slides = slideOrder(entries);
  const targets =
    replacement.slideNumber && replacement.slideNumber > 0
      ? slides.slice(replacement.slideNumber - 1, replacement.slideNumber)
      : slides;
  let count = 0;
  for (const slide of targets) {
    const xml = getXml(entries, slide.path);
    if (!xml) continue;
    const updated = replaceTextNodes(xml, "a:t", replacement);
    if (updated.count > 0) {
      count += updated.count;
      setXml(entries, slide.path, updated.xml);
    }
  }
  return count;
}

function replacePptxSlideTitle(entries: ZipEntries, change: SlideTitleChange): number {
  const slide = slideOrder(entries)[change.slideNumber - 1];
  if (!slide) return 0;
  const xml = getXml(entries, slide.path);
  if (!xml) return 0;
  let changed = false;
  const updatedXml = xml.replace(
    /(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)/,
    (full, open: string, _inner: string, close: string) => {
      if (changed) return full;
      changed = true;
      return `${open}${xmlEscape(change.newText)}${close}`;
    },
  );
  if (!changed) return 0;
  setXml(entries, slide.path, updatedXml);
  return 1;
}

function shortenPptxSlide(entries: ZipEntries, slideNumber: number): number {
  const slide = slideOrder(entries)[slideNumber - 1];
  if (!slide) return 0;
  const xml = getXml(entries, slide.path);
  if (!xml) return 0;
  const updated = shortenTextNodes(xml);
  if (updated.count > 0) setXml(entries, slide.path, updated.xml);
  return updated.count;
}

function professionalizePptx(entries: ZipEntries): number {
  let count = 0;
  for (const slide of slideOrder(entries)) {
    const xml = getXml(entries, slide.path);
    if (!xml) continue;
    const updated = professionalizeTextNodes(xml, "a:t");
    if (updated.count > 0) {
      count += updated.count;
      setXml(entries, slide.path, updated.xml);
    }
  }
  return count;
}

function parseDocxAddition(message: string): { heading?: string; content: string } | null {
  if (!/\b(add|insert|append|include|create)\b/i.test(message)) return null;
  if (
    !/\b(section|paragraph|note|text|summary|recommendation|conclusion|appendix)\b/i.test(message)
  ) {
    return null;
  }
  const sectionWithContent =
    /\b(?:add|insert|append|include|create)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:section|paragraph|note|summary|recommendation|conclusion|appendix)\s+(?:called|named|titled)\s+["\u201c]?(.{2,120}?)(?:["\u201d]|\s+\b(?:with|content|text)\b)\s+(?:with\s+)?(?:content|text|saying|that\s+says)?\s*["\u201c]?(.{2,260}?)(?:["\u201d]|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    );
  if (sectionWithContent) {
    const heading = cleanGeneratedText(sectionWithContent[1] ?? "");
    const content = cleanGeneratedText(sectionWithContent[2] ?? "");
    if (heading || content) {
      return {
        ...(heading ? { heading } : {}),
        content: content || heading || "Additional notes",
      };
    }
  }
  const headingMatch =
    /\b(?:section|heading|title)\s+["â€œ]?(.{2,120}?)(?:["â€]|\s+\b(?:with|and|then|return|send|give)\b|$)/i.exec(
      message,
    );
  const contentMatch =
    /\b(?:with|saying|that\s+says|content|text)\s+["â€œ]?(.{2,260}?)(?:["â€]|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    ) ??
    /\b(?:add|insert|append|include)\s+(?:a\s+)?(?:section|paragraph|note|text)\s+(?:about|for)?\s*["â€œ]?(.{2,260}?)(?:["â€]|\s+\b(?:and|then|return|send|give)\b|$)/i.exec(
      message,
    );
  const heading = cleanGeneratedText(headingMatch?.[1] ?? "");
  const content = cleanGeneratedText(contentMatch?.[1] ?? "");
  if (!content && !heading) return null;
  return {
    ...(heading ? { heading } : {}),
    content: content || heading || "Additional notes",
  };
}

function buildDocxParagraphXml(text: string, style?: "heading"): string {
  const styleXml = style ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : "";
  return `<w:p>${styleXml}<w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function appendDocxContent(
  docXml: string,
  addition: { heading?: string; content: string },
): {
  xml: string;
  count: number;
} {
  const bodyClose = "</w:body>";
  if (!docXml.includes(bodyClose)) return { xml: docXml, count: 0 };
  const paragraphs = [
    ...(addition.heading ? [buildDocxParagraphXml(addition.heading, "heading")] : []),
    buildDocxParagraphXml(addition.content),
  ];
  return {
    xml: docXml.replace(bodyClose, `${paragraphs.join("")}${bodyClose}`),
    count: paragraphs.length,
  };
}

function base64Raw(entry: FileEntry): Buffer | null {
  if (!entry.rawBase64 || !entry.rawFileType) return null;
  try {
    return Buffer.from(entry.rawBase64, "base64");
  } catch {
    return null;
  }
}

/* ── Edit-quality card metadata ─────────────────────────────────────────── */

const EDIT_QUALITY_MAX_CHANGES = 20;
const EDIT_QUALITY_MAX_CHANGE_CHARS = 300;
const EDIT_QUALITY_MAX_WARNING_CHARS = 500;
const EDIT_QUALITY_MAX_NAME_CHARS = 300;
const EDIT_QUALITY_MAX_OP_SNIPPET_CHARS = 80;

function truncateForCard(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function capitalizeChange(text: string): string {
  const clean = text.trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : clean;
}

/** Human-readable change line for one applied AI edit op. */
function describeAiOfficeEditOp(op: AiOfficeEditOp): string {
  const find = truncateForCard(op.find, EDIT_QUALITY_MAX_OP_SNIPPET_CHARS);
  const replace = truncateForCard(op.replace, EDIT_QUALITY_MAX_OP_SNIPPET_CHARS);
  return replace ? `Replaced: "${find}" → "${replace}"` : `Removed: "${find}"`;
}

/**
 * Build the quality-card metadata for a layout-pipeline result. Values are
 * defensively truncated to the persistence schema caps so a long honest note
 * or filename can never make the message fail validation on save.
 */
function buildEditQuality(input: {
  editMode: OraFileEditQuality["editMode"];
  entry: FileEntry;
  outputFileName: string;
  type: OfficeRawType;
  changes?: string[];
  warning?: string;
}): OraFileEditQuality {
  const changes = (input.changes ?? [])
    .map((change) => truncateForCard(change, EDIT_QUALITY_MAX_CHANGE_CHARS))
    .filter(Boolean)
    .slice(0, EDIT_QUALITY_MAX_CHANGES);
  return {
    editMode: input.editMode,
    changes,
    originalFileName: truncateForCard(input.entry.filename, EDIT_QUALITY_MAX_NAME_CHARS),
    outputFileName: truncateForCard(input.outputFileName, EDIT_QUALITY_MAX_NAME_CHARS),
    sourceFileType: input.type,
    // The layout pipeline never rebuilds: edits are in-place and every
    // non-edit outcome returns the original bytes untouched.
    preservedLayout: true,
    canRedesign: true,
    ...(input.warning
      ? { warning: truncateForCard(input.warning, EDIT_QUALITY_MAX_WARNING_CHARS) }
      : {}),
  };
}

function buildOfficeResult(
  entry: FileEntry,
  type: OfficeRawType,
  buffer: Buffer,
  action: string,
  changes?: string[],
): GeneratedFileResult {
  const slideCount =
    type === "pptx"
      ? Math.max(1, (entry.extractedText.match(/\bSlide\s+\d+:/gi) ?? []).length)
      : undefined;
  const fileName = safeFileName(entry.filename, type);
  return {
    fileName,
    fileData: buffer.toString("base64"),
    mimeType: MIME_BY_TYPE[type],
    reply: `I've updated the original ${type.toUpperCase()} file (${action}) while preserving its existing layout where possible. Click the card below to download it.`,
    ...(type === "pptx" ? { slideCount } : {}),
    editQuality: buildEditQuality({
      editMode: "original_edited",
      entry,
      outputFileName: fileName,
      type,
      changes: changes && changes.length > 0 ? changes : [capitalizeChange(action)],
    }),
  };
}

async function editPptx(entry: FileEntry, message: string): Promise<GeneratedFileResult | null> {
  const raw = base64Raw(entry);
  if (!raw) return null;
  const entries = unzipSync(new Uint8Array(raw));
  const plan = planUploadedFileRequest(message);
  const deleteSlide = parseDeleteSlide(message);
  if (deleteSlide) {
    const changed = deletePptxSlide(entries, deleteSlide);
    if (changed > 0) {
      return buildOfficeResult(entry, "pptx", zipBuffer(entries), `removed slide ${deleteSlide}`);
    }
  }

  const slideMove = parseSlideMove(message);
  if (slideMove) {
    const changed = movePptxSlide(entries, slideMove);
    if (changed > 0) {
      return buildOfficeResult(
        entry,
        "pptx",
        zipBuffer(entries),
        `moved slide ${slideMove.slideNumber} ${slideMove.placement} slide ${slideMove.targetSlideNumber}`,
      );
    }
  }

  const titleChange = parseSlideTitleChange(message);
  if (titleChange) {
    const changed = replacePptxSlideTitle(entries, titleChange);
    if (changed > 0) {
      return buildOfficeResult(
        entry,
        "pptx",
        zipBuffer(entries),
        `renamed slide ${titleChange.slideNumber}`,
      );
    }
  }

  const slideTextAddition = parseSlideTextAddition(message);
  if (slideTextAddition) {
    const changed = addPptxTextToSlide(entries, slideTextAddition);
    if (changed > 0) {
      return buildOfficeResult(
        entry,
        "pptx",
        zipBuffer(entries),
        `added text to slide ${slideTextAddition.slideNumber}`,
      );
    }
  }

  const slideInsertion = parseSlideInsertion(message);
  if (slideInsertion && (plan.operations.includes("add") || plan.operations.includes("insert"))) {
    const changed = insertPptxSlide(entries, slideInsertion);
    if (changed > 0) {
      return buildOfficeResult(entry, "pptx", zipBuffer(entries), `added a new slide`);
    }
  }

  const replacement = parseTextReplacement(message) ?? parseTextDeletion(message);
  if (replacement) {
    const changed = replacePptxText(entries, replacement);
    if (changed > 0) {
      const action = replacement.newText
        ? `replaced "${replacement.oldText}"`
        : `removed "${replacement.oldText}"`;
      return buildOfficeResult(entry, "pptx", zipBuffer(entries), action);
    }
  }

  const shortenSlide = parseShortenSlide(message);
  if (shortenSlide) {
    const changed = shortenPptxSlide(entries, shortenSlide);
    if (changed > 0) {
      return buildOfficeResult(
        entry,
        "pptx",
        zipBuffer(entries),
        `shortened slide ${shortenSlide}`,
      );
    }
  }

  if (hasProfessionalizeIntent(message)) {
    const changed = professionalizePptx(entries);
    if (changed > 0) {
      return buildOfficeResult(
        entry,
        "pptx",
        zipBuffer(entries),
        `polished ${changed} text item${changed === 1 ? "" : "s"}`,
      );
    }
  }

  return null;
}

async function editDocx(entry: FileEntry, message: string): Promise<GeneratedFileResult | null> {
  const raw = base64Raw(entry);
  const replacement = parseTextReplacement(message) ?? parseTextDeletion(message);
  if (!raw) return null;
  const entries = unzipSync(new Uint8Array(raw));
  const docXml = getXml(entries, "word/document.xml");
  if (!docXml) return null;
  const plan = planUploadedFileRequest(message);
  if (replacement) {
    const updated = replaceTextNodes(docXml, "w:t", replacement);
    if (updated.count > 0) {
      setXml(entries, "word/document.xml", updated.xml);
      const action = replacement.newText
        ? `replaced "${replacement.oldText}"`
        : `removed "${replacement.oldText}"`;
      return buildOfficeResult(entry, "docx", zipBuffer(entries), action);
    }
  }

  const addition = parseDocxAddition(message);
  if (addition && (plan.operations.includes("add") || plan.operations.includes("insert"))) {
    const updated = appendDocxContent(docXml, addition);
    if (updated.count > 0) {
      setXml(entries, "word/document.xml", updated.xml);
      return buildOfficeResult(
        entry,
        "docx",
        zipBuffer(entries),
        `added ${updated.count} document item${updated.count === 1 ? "" : "s"}`,
      );
    }
  }

  if (hasProfessionalizeIntent(message)) {
    const updated = professionalizeTextNodes(docXml, "w:t");
    if (updated.count > 0) {
      setXml(entries, "word/document.xml", updated.xml);
      return buildOfficeResult(
        entry,
        "docx",
        zipBuffer(entries),
        `polished ${updated.count} text item${updated.count === 1 ? "" : "s"}`,
      );
    }
  }

  return null;
}

function tabularDataFromSummary(entry: FileEntry, summary: DatasetSummary): TabularData {
  return {
    title: entry.filename.replace(/\.[^.]+$/i, "") || "Uploaded workbook",
    sheetName: summary.sheetName,
    headers: summary.headers,
    columnTypes: summary.columnProfiles.map((profile) =>
      profile.type === "numeric" ? "number" : profile.type === "date" ? "date" : "text",
    ),
    rows: summary.sampleRows,
  };
}

function hasCalculationIntent(message: string): boolean {
  return /\b(formulas?|calculations?|calculate|computed?|totals?|sum|average|avg|minimum|maximum|min|max|count|commission|quota|margin|rate|kpi|metrics?|model|dashboard)\b/i.test(
    message,
  );
}

function excelColumnName(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    n = Math.floor((n - mod) / 26);
  }
  return out || "A";
}

function quoteSheetNameForFormula(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const maybe = value as {
      text?: unknown;
      result?: unknown;
      richText?: Array<{ text?: unknown }>;
    };
    if (typeof maybe.text === "string") return maybe.text;
    if (maybe.result != null) return String(maybe.result);
    if (Array.isArray(maybe.richText)) {
      return maybe.richText.map((part) => String(part.text ?? "")).join("");
    }
  }
  return "";
}

function replaceXlsxText(workbook: ExcelJS.Workbook, replacement: TextReplacement): number {
  const oldNorm = normalizePhrase(replacement.oldText);
  const oldRegex = new RegExp(escapeRegExp(oldNorm), "i");
  const keywords = meaningfulTargetKeywords(oldNorm);
  let count = 0;
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = normalizePhrase(cellText(cell.value));
        if (!text) return;
        if (oldRegex.test(text)) {
          const next = String(cellText(cell.value)).replace(
            new RegExp(escapeRegExp(replacement.oldText), "gi"),
            replacement.newText,
          );
          cell.value = next === cellText(cell.value) ? replacement.newText : next;
          count += 1;
          return;
        }
        if (keywords.length > 0 && keywords.every((word) => text.toLowerCase().includes(word))) {
          cell.value = replacement.newText;
          count += 1;
        }
      });
    });
  });
  return count;
}

function deleteXlsxColumn(workbook: ExcelJS.Workbook, target: string): number {
  const targetNorm = normalizePhrase(target).toLowerCase();
  const keywords = meaningfulTargetKeywords(target);
  let changed = 0;
  workbook.eachSheet((sheet) => {
    const headerRow = sheet.getRow(1);
    let targetCol = 0;
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (targetCol > 0) return;
      const header = normalizePhrase(cellText(cell.value)).toLowerCase();
      if (
        header === targetNorm ||
        (keywords.length > 0 && keywords.every((word) => header.includes(word)))
      ) {
        targetCol = colNumber;
      }
    });
    if (targetCol > 0) {
      sheet.spliceColumns(targetCol, 1);
      changed += 1;
    }
  });
  return changed;
}

function addXlsxColumn(workbook: ExcelJS.Workbook, header: string): number {
  const sheet = workbook.worksheets[0];
  if (!sheet) return 0;
  const maxCol = Math.max(1, sheet.actualColumnCount || sheet.columnCount || 1);
  const headerRow = sheet.getRow(1);
  let exists = false;
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    if (normalizePhrase(cellText(cell.value)).toLowerCase() === header.toLowerCase()) {
      exists = true;
    }
  });
  if (exists) return 0;
  const nextCol = maxCol + 1;
  sheet.getCell(1, nextCol).value = header;
  sheet.getCell(1, nextCol).font = { ...(sheet.getCell(1, nextCol).font ?? {}), bold: true };
  for (let rowNumber = 2; rowNumber <= Math.max(sheet.actualRowCount, 2); rowNumber++) {
    sheet.getCell(rowNumber, nextCol).value = "";
  }
  return 1;
}

function addXlsxRow(workbook: ExcelJS.Workbook, values: string[]): number {
  const sheet = workbook.worksheets[0];
  if (!sheet) return 0;
  const maxCol = Math.max(
    sheet.actualColumnCount || sheet.columnCount || values.length,
    values.length,
  );
  const rowValues = Array.from({ length: maxCol }, (_, index) => values[index] ?? "");
  sheet.addRow(rowValues);
  return 1;
}

function addXlsxWorksheet(workbook: ExcelJS.Workbook, name: string): number {
  const safeName = name.slice(0, 31) || "New Sheet";
  if (workbook.getWorksheet(safeName)) return 0;
  const sheet = workbook.addWorksheet(safeName);
  sheet.getCell("A1").value = safeName;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  return 1;
}

function renameXlsxWorksheet(
  workbook: ExcelJS.Workbook,
  rename: { oldName?: string; newName: string },
): number {
  const sheet = rename.oldName ? workbook.getWorksheet(rename.oldName) : workbook.worksheets[0];
  if (!sheet || workbook.getWorksheet(rename.newName)) return 0;
  sheet.name = rename.newName;
  return 1;
}

function dedupeXlsxRows(workbook: ExcelJS.Workbook): number {
  let removed = 0;
  workbook.eachSheet((sheet) => {
    const seen = new Set<string>();
    for (let rowNumber = sheet.actualRowCount; rowNumber >= 2; rowNumber--) {
      const row = sheet.getRow(rowNumber);
      const values: string[] = [];
      for (let colNumber = 1; colNumber <= Math.max(sheet.actualColumnCount, 1); colNumber++) {
        values.push(normalizePhrase(cellText(row.getCell(colNumber).value)).toLowerCase());
      }
      const key = values.join("\u0001");
      if (!key.trim()) continue;
      if (seen.has(key)) {
        sheet.spliceRows(rowNumber, 1);
        removed += 1;
      } else {
        seen.add(key);
      }
    }
  });
  return removed;
}

function sortXlsxByColumn(workbook: ExcelJS.Workbook, target: string): number {
  let changed = 0;
  const keywords = meaningfulTargetKeywords(target);
  workbook.eachSheet((sheet) => {
    const headerRow = sheet.getRow(1);
    let targetCol = 0;
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = normalizePhrase(cellText(cell.value)).toLowerCase();
      if (
        header === target.toLowerCase() ||
        (keywords.length > 0 && keywords.every((word) => header.includes(word)))
      ) {
        targetCol = colNumber;
      }
    });
    if (!targetCol || sheet.actualRowCount <= 2) return;
    const rows: ExcelJS.CellValue[][] = [];
    for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const values: ExcelJS.CellValue[] = [];
      for (let colNumber = 1; colNumber <= Math.max(sheet.actualColumnCount, 1); colNumber++) {
        values.push(row.getCell(colNumber).value);
      }
      rows.push(values);
    }
    rows.sort((a, b) =>
      String(a[targetCol - 1] ?? "").localeCompare(String(b[targetCol - 1] ?? ""), undefined, {
        numeric: true,
      }),
    );
    rows.forEach((values, index) => {
      sheet.getRow(index + 2).values = values;
    });
    changed += 1;
  });
  return changed;
}

function cleanXlsxWorkbook(workbook: ExcelJS.Workbook): number {
  let changed = 0;
  workbook.eachSheet((sheet) => {
    const maxCol = Math.max(1, sheet.actualColumnCount || sheet.columnCount || 1);
    sheet.eachRow((row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value === "string") {
          const next = normalizePhrase(cell.value);
          if (next !== cell.value) {
            cell.value = next;
            changed += 1;
          }
        }
        if (rowNumber === 1) {
          cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: "FF111827" } };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFEFF6FF" },
          };
          cell.alignment = { ...(cell.alignment ?? {}), vertical: "middle", wrapText: true };
        }
      });
      if (rowNumber === 1) row.height = Math.max(row.height || 0, 22);
    });

    sheet.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2" }];
    if (sheet.actualRowCount > 1 && maxCol > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: maxCol },
      };
    }
    for (let colIdx = 1; colIdx <= maxCol; colIdx++) {
      const column = sheet.getColumn(colIdx);
      let maxLen = 10;
      column.eachCell({ includeEmpty: false }, (cell) => {
        maxLen = Math.max(maxLen, cellText(cell.value).length);
      });
      column.width = Math.min(Math.max(maxLen + 2, 12), 42);
    }
    changed += 1;
  });
  return changed;
}

function sourceSheetForDataset(
  workbook: ExcelJS.Workbook,
  summary: DatasetSummary,
): ExcelJS.Worksheet | null {
  if (summary.sheetName) {
    const named = workbook.getWorksheet(summary.sheetName);
    if (named) return named;
  }
  return workbook.worksheets[0] ?? null;
}

function addCalculationWorksheet(workbook: ExcelJS.Workbook, summary: DatasetSummary): number {
  const sourceSheet = sourceSheetForDataset(workbook, summary);
  if (!sourceSheet) return 0;
  const numericProfiles = summary.columnProfiles.filter((profile) => profile.type === "numeric");
  if (numericProfiles.length === 0) return 0;

  const existing = workbook.getWorksheet("Ora Calculations");
  if (existing) workbook.removeWorksheet(existing.id);
  const sheet = workbook.addWorksheet("Ora Calculations");
  sheet.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Formula", key: "formula", width: 42 },
    { header: "Value", key: "value", width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  const sourceName = quoteSheetNameForFormula(sourceSheet.name);
  const lastRow = Math.max(2, (summary.rowCount || sourceSheet.actualRowCount || 1) + 1);
  let row = 2;

  for (const profile of numericProfiles.slice(0, 8)) {
    const header = summary.headers[profile.index] ?? `Column ${profile.index + 1}`;
    const col = excelColumnName(profile.index + 1);
    const range = `${sourceName}!${col}2:${col}${lastRow}`;
    for (const [label, formula] of [
      [`${header} total`, `SUM(${range})`],
      [`${header} average`, `AVERAGE(${range})`],
      [`${header} count`, `COUNT(${range})`],
    ] as const) {
      sheet.getCell(row, 1).value = label;
      sheet.getCell(row, 2).value = formula;
      sheet.getCell(row, 3).value = { formula };
      row += 1;
    }
  }

  return row - 2;
}

async function addChartsWorksheet(
  workbook: ExcelJS.Workbook,
  entry: FileEntry,
  message: string,
): Promise<number> {
  if (!entry.datasetSummary) return 0;
  const data = tabularDataFromSummary(entry, entry.datasetSummary);
  const charts = inferChartsFromTabularData(data, message, 3);
  if (charts.length === 0) return 0;

  const existing = workbook.getWorksheet("Ora Charts");
  if (existing) workbook.removeWorksheet(existing.id);
  const sheet = workbook.addWorksheet("Ora Charts");
  sheet.getCell("A1").value = "Ora generated charts";
  sheet.getCell("A1").font = { bold: true, size: 16 };

  let row = 3;
  for (const chart of charts) {
    sheet.getCell(`A${row}`).value = chart.title;
    sheet.getCell(`A${row}`).font = { bold: true, size: 13 };
    const png = await renderChartPng(chart, 900, 420);
    const imageId = workbook.addImage({
      buffer: png as unknown as Parameters<typeof workbook.addImage>[0]["buffer"],
      extension: "png",
    });
    sheet.addImage(imageId, `A${row + 1}:H${row + 18}`);
    row += 21;
  }

  sheet.getCell(`A${row}`).value = "Chart source values";
  sheet.getCell(`A${row}`).font = { bold: true };
  row += 1;
  for (const chart of charts) {
    sheet.getCell(`A${row}`).value = chart.title;
    row += 1;
    sheet.getRow(row).values = ["Label", "Value"];
    sheet.getRow(row).font = { bold: true };
    row += 1;
    chart.labels.forEach((label, index) => {
      sheet.getRow(row).values = [label, chart.values[index] ?? null];
      row += 1;
    });
    row += 1;
  }

  sheet.columns = [{ width: 32 }, { width: 18 }, { width: 18 }, { width: 18 }];
  return charts.length;
}

async function editXlsx(entry: FileEntry, message: string): Promise<GeneratedFileResult | null> {
  const raw = base64Raw(entry);
  if (!raw) return null;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const actions: string[] = [];
  const plan = planUploadedFileRequest(message);

  const renameSheet = parseRenameSheet(message);
  if (renameSheet) {
    const changed = renameXlsxWorksheet(workbook, renameSheet);
    if (changed > 0) actions.push(`renamed ${changed} worksheet${changed === 1 ? "" : "s"}`);
  }

  const addSheetName = parseAddSheetName(message);
  if (addSheetName) {
    const changed = addXlsxWorksheet(workbook, addSheetName);
    if (changed > 0) actions.push(`added worksheet "${addSheetName}"`);
  }

  const addColumn = parseAddColumn(message);
  if (addColumn) {
    const changed = addXlsxColumn(workbook, addColumn);
    if (changed > 0) actions.push(`added ${changed} column${changed === 1 ? "" : "s"}`);
  }

  const addRow = parseAddRow(message);
  if (addRow) {
    const changed = addXlsxRow(workbook, addRow);
    if (changed > 0) actions.push(`added ${changed} row${changed === 1 ? "" : "s"}`);
  }

  const deleteColumn = parseDeleteColumn(message);
  if (deleteColumn) {
    const changed = deleteXlsxColumn(workbook, deleteColumn);
    if (changed > 0) actions.push(`removed ${changed} column${changed === 1 ? "" : "s"}`);
  }

  const replacement = deleteColumn
    ? null
    : (parseTextReplacement(message) ?? parseTextDeletion(message));
  if (replacement) {
    const changed = replaceXlsxText(workbook, replacement);
    if (changed > 0) actions.push(`updated ${changed} cell${changed === 1 ? "" : "s"}`);
  }

  if (entry.datasetSummary && hasCalculationIntent(message)) {
    const formulas = addCalculationWorksheet(workbook, entry.datasetSummary);
    if (formulas > 0) actions.push("added an Ora Calculations worksheet with real formulas");
  }

  if (entry.datasetSummary && hasChartIntent(message)) {
    const charts = await addChartsWorksheet(workbook, entry, message);
    if (charts > 0) actions.push(`added ${charts} generated chart${charts === 1 ? "" : "s"}`);
  }

  const sortColumn = parseSortColumn(message);
  if (sortColumn) {
    const changed = sortXlsxByColumn(workbook, sortColumn);
    if (changed > 0) actions.push(`sorted ${changed} sheet${changed === 1 ? "" : "s"}`);
  }

  if (plan.operations.includes("format") && /\b(dedupe|deduplicate|duplicates?)\b/i.test(message)) {
    const changed = dedupeXlsxRows(workbook);
    if (changed > 0) actions.push(`removed ${changed} duplicate row${changed === 1 ? "" : "s"}`);
  }

  if (hasSpreadsheetCleanIntent(message) || hasProfessionalizeIntent(message)) {
    const changed = cleanXlsxWorkbook(workbook);
    if (changed > 0) actions.push("cleaned and formatted the workbook");
  }

  if (actions.length === 0) return null;

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = safeFileName(entry.filename, "xlsx");
  return {
    fileName,
    fileData: buffer.toString("base64"),
    mimeType: MIME_BY_TYPE.xlsx,
    reply: `I've updated the original XLSX file (${actions.join("; ")}) while preserving the workbook where possible. Click the card below to download it.`,
    ...(entry.datasetSummary ? { rowCount: entry.datasetSummary.rowCount } : {}),
    editQuality: buildEditQuality({
      editMode: "original_edited",
      entry,
      outputFileName: fileName,
      type: "xlsx",
      changes: actions.map(capitalizeChange),
    }),
  };
}

export async function resolveRawOfficeEntry(
  input: LayoutEditInput,
): Promise<{ entry: FileEntry; fileRef: string } | null> {
  // Phase 10: active working artifact takes highest priority — the user is
  // explicitly revising the file they just generated/edited. Build a synthetic
  // FileEntry from the provided buffer so the rest of the edit engine can work
  // identically regardless of whether the source was an upload or a generation.
  if (input.activeAssetBuffer && input.activeAssetFileName) {
    const rawFileType = input.format as OfficeRawType;
    // xlsx extraction is not supported by extractText (only txt/docx/pptx/pdf).
    const supportsExtract = rawFileType === "docx" || rawFileType === "pptx";
    if (!MIME_BY_TYPE[rawFileType]) return null; // unsupported format guard
    let extractedText = "";
    if (supportsExtract) {
      try {
        const { extractText } = await import("./file-extract.js");
        const text = await extractText(
          input.activeAssetBuffer,
          rawFileType as "docx" | "pptx",
        );
        if (text.trim()) extractedText = text.slice(0, MAX_TEXT_CHARS_PER_FILE);
      } catch {
        // Proceed with empty text — the regex/AI edit paths still work
      }
    }
    const syntheticEntry: FileEntry = {
      sessionId: input.sessionId,
      filename: input.activeAssetFileName,
      mimeType: MIME_BY_TYPE[rawFileType],
      charCount: extractedText.length,
      extractedText,
      rawBase64: input.activeAssetBuffer.toString("base64"),
      rawSizeBytes: input.activeAssetBuffer.length,
      rawFileType,
      expiresAt: Date.now() + 3_600_000,
    };
    return { entry: syntheticEntry, fileRef: ACTIVE_ASSET_FILEREF };
  }
  // Planner-steered target first: never silently edit the wrong file when the
  // multi-file planner already resolved WHICH upload the user meant.
  if (input.preferredFileRef) {
    const preferred = await resolveFileEntry(input.preferredFileRef, {
      sessionId: input.sessionId,
      userId: input.userId,
    });
    if (preferred?.rawFileType === input.format && preferred.rawBase64) {
      return { entry: preferred, fileRef: input.preferredFileRef };
    }
  }
  for (const ref of input.documentRefs) {
    const entry = await resolveFileEntry(ref, { sessionId: input.sessionId, userId: input.userId });
    if (!entry?.rawFileType || !entry.rawBase64) continue;
    if (entry.rawFileType === input.format) return { entry, fileRef: ref };
  }
  return null;
}

/**
 * "Send it back / give me the file" style requests with no edit operation.
 * These must return the ORIGINAL bytes untouched — regenerating a lookalike
 * from extracted text destroys the user's layout, images, and styling.
 */
const RETURN_ORIGINAL_PATTERN =
  /\b(?:return|send|give|share|resend|re-?send|download|provide|attach|upload)\b[^.?!\n]{0,80}\b(?:file|document|doc|deck|presentation|slides?|power[\s-]?point|pptx?|spreadsheet|workbook|excel|xlsx|docx|word|copy|it)\b/i;

const UNCHANGED_PATTERN =
  /\b(?:same|original|unchanged|as[-\s]is|untouched|without\s+(?:any\s+)?(?:changes?|modifications?|edits?)|exactly\s+as)\b/i;

function isReturnOriginalRequest(message: string): boolean {
  if (!RETURN_ORIGINAL_PATTERN.test(message)) return false;
  const plan = planUploadedFileRequest(message);
  if (plan.operations.length === 0) return true;
  return (
    UNCHANGED_PATTERN.test(message) && !plan.operations.some((op) => FILE_OUTPUT_OPERATIONS.has(op))
  );
}

/**
 * Operations that are textual/in-place by nature — safe to route through the
 * AI edit planner. Transform-style operations (convert/chart/merge/...) and
 * explicit "new document" requests keep the full regeneration path.
 */
const IN_PLACE_OPS = new Set<UploadedFileOperation>([
  "replace",
  "delete",
  "rewrite",
  "rename",
  "translate",
  "format",
  "professionalize",
  "add",
  "insert",
  "move",
  "reorder",
]);

const TRANSFORM_OPS = new Set<UploadedFileOperation>([
  "convert",
  "chart",
  "dashboard",
  "formula",
  "merge",
  "split",
]);

const NEW_DOC_PATTERN =
  /\b(?:(?:a|an)\s+(?:brand[\s-]?)?new\s+(?:deck|presentation|document|doc|file|report|spreadsheet|workbook|version)|from\s+scratch|start\s+over)\b/i;

function isInPlaceEditIntent(message: string): boolean {
  const plan = planUploadedFileRequest(message);
  if (!plan.operations.some((op) => IN_PLACE_OPS.has(op))) return false;
  if (plan.operations.some((op) => TRANSFORM_OPS.has(op))) return false;
  if (NEW_DOC_PATTERN.test(message)) return false;
  return true;
}

/** Return the current bytes under the ORIGINAL filename, explicitly unchanged. */
function buildPassthroughResult(
  entry: FileEntry,
  type: OfficeRawType,
  reply: string,
  quality: { editMode: "unchanged" | "failed_safe"; warning?: string },
): GeneratedFileResult {
  return {
    fileName: entry.filename,
    fileData: entry.rawBase64!,
    mimeType: MIME_BY_TYPE[type],
    reply,
    editQuality: buildEditQuality({
      editMode: quality.editMode,
      entry,
      outputFileName: entry.filename,
      type,
      warning: quality.warning,
    }),
  };
}

/**
 * After a REAL in-place edit, update the in-memory file entry with the new
 * bytes (and re-extracted text for docx/pptx) so follow-up edits in this
 * session compound on the edited version instead of silently reverting to the
 * original upload. Best-effort — failure never blocks returning the result.
 * Returns true when the session entry was updated; callers then mark the
 * result with `editedFileRef` so the route layer can repoint the durable
 * mirror at the newly persisted (edited) library asset — otherwise edits
 * after a server restart would re-start from the original upload.
 */
async function writeBackEditedEntry(
  input: LayoutEditInput,
  fileRef: string,
  entry: FileEntry,
  result: GeneratedFileResult,
): Promise<boolean> {
  // Phase 10: synthetic active-asset entries have no session store row to
  // update. The route layer handles version chaining via the original assetId.
  if (fileRef === ACTIVE_ASSET_FILEREF) return true;
  try {
    const buffer = Buffer.from(result.fileData, "base64");
    if (buffer.length === 0 || buffer.length > MAX_RAW_BYTES_PER_FILE) return false;
    let extractedText = entry.extractedText;
    if (entry.rawFileType === "docx" || entry.rawFileType === "pptx") {
      try {
        const { extractText } = await import("./file-extract.js");
        const text = await extractText(buffer, entry.rawFileType);
        if (text.trim()) extractedText = text.slice(0, MAX_TEXT_CHARS_PER_FILE);
      } catch (err) {
        logger.warn(
          { component: "ora-office-edit", err, fileType: entry.rawFileType },
          "Failed to re-extract text after in-place edit — keeping prior text",
        );
      }
    }
    const { expiresAt: _expiresAt, ...rest } = entry;
    putFileEntry(fileRef, {
      ...rest,
      sessionId: input.sessionId,
      extractedText,
      charCount: extractedText.length,
      rawBase64: result.fileData,
      rawSizeBytes: buffer.length,
    });
    return true;
  } catch (err) {
    logger.warn(
      { component: "ora-office-edit", err },
      "Failed to write back edited Office file to the session store",
    );
    return false;
  }
}

export async function tryApplyLayoutPreservingFileEdit(
  input: LayoutEditInput,
): Promise<GeneratedFileResult | null> {
  if (input.format !== "docx" && input.format !== "pptx" && input.format !== "xlsx") return null;
  const resolved = await resolveRawOfficeEntry(input);
  if (!resolved) return null;
  const { entry, fileRef } = resolved;
  const type = entry.rawFileType as OfficeRawType;

  // 1) "Send it back" with no edit request → original bytes, untouched.
  if (isReturnOriginalRequest(input.message)) {
    return buildPassthroughResult(
      entry,
      type,
      `Here's your file "${entry.filename}" exactly as it is — no changes made. Click the card below to download it.`,
      { editMode: "unchanged" },
    );
  }

  // 2) Deterministic regex edit engines (fast, no model call).
  let result: GeneratedFileResult | null;
  if (type === "pptx") result = await editPptx(entry, input.message);
  else if (type === "docx") result = await editDocx(entry, input.message);
  else result = await editXlsx(entry, input.message);
  if (result) {
    const wroteBack = await writeBackEditedEntry(input, fileRef, entry, result);
    if (wroteBack && fileRef !== ACTIVE_ASSET_FILEREF) result.editedFileRef = fileRef;
    return result;
  }

  // 3) AI-planned in-place ops for edit phrasings the regexes don't cover.
  if (!isInPlaceEditIntent(input.message)) return null;
  let appliedCount = 0;
  let honestNote: string | null = null;
  try {
    const { planAiOfficeEditOps } = await import("./office-ai-edit.js");
    const aiPlan = await planAiOfficeEditOps({
      message: input.message,
      extractedText: entry.extractedText,
      filename: entry.filename,
      fileType: type,
      subscriptionTier: input.subscriptionTier ?? null,
    });
    // In-place intent is confirmed at this point, so NEITHER a planner
    // failure NOR a "regenerate" vote may fall through to full regeneration —
    // that silently rebuilds a lookalike and destroys the user's layout
    // (confirmed in production). Both paths drop to the honest passthrough.
    if (aiPlan?.mode === "regenerate") {
      honestNote = `This change looks like it would mean restructuring "${entry.filename}" as a whole, and I don't rebuild an uploaded file silently — that would lose your original layout, styling, and images. Tell me the specific text to change and I'll edit it in place. If you really do want a full rebuild, say "rebuild it from scratch".`;
    }

    if (aiPlan && aiPlan.mode === "edit" && aiPlan.operations.length > 0) {
      const applied = await applyAiOfficeEditOps(entry, type, aiPlan.operations);
      if (applied && applied.appliedCount > 0) {
        appliedCount = applied.appliedCount;
        const changes = applied.appliedIndices
          .map((i) => aiPlan.operations[i])
          .filter((op): op is AiOfficeEditOp => Boolean(op))
          .map(describeAiOfficeEditOp);
        const editResult = buildOfficeResult(
          entry,
          type,
          applied.buffer,
          `applied ${applied.appliedCount} text edit${applied.appliedCount === 1 ? "" : "s"}`,
          changes,
        );
        const wroteBack = await writeBackEditedEntry(input, fileRef, entry, editResult);
        if (wroteBack && fileRef !== ACTIVE_ASSET_FILEREF) editResult.editedFileRef = fileRef;
        return editResult;
      }
    }
  } catch (err) {
    logger.warn(
      { component: "ora-office-edit", err, fileType: type },
      "AI in-place edit path failed — falling through to no-silent-regeneration guard",
    );
  }

  // 4) In-place intent confirmed but nothing could be located/applied →
  //    return the file unchanged with an honest note instead of silently
  //    rebuilding a lookalike that loses the user's layout.
  logger.info(
    { component: "ora-office-edit", fileType: type, appliedCount },
    "In-place edit intent with no applicable ops — returning file unchanged",
  );
  return buildPassthroughResult(
    entry,
    type,
    honestNote ??
      `I couldn't locate the exact text to change in "${entry.filename}", so I'm returning it unchanged rather than rebuilding it from scratch (that would lose your layout and styling). Tell me the exact wording to change — for example: replace "Old heading" with "New heading" — and I'll edit it in place.`,
    {
      editMode: "failed_safe",
      warning: honestNote
        ? "The requested change would mean restructuring the whole file, so the original was returned unchanged to protect its layout."
        : "Couldn't locate the exact text to change, so the original file was returned unchanged.",
    },
  );
}
