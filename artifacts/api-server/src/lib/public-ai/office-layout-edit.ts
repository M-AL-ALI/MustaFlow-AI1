import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { planUploadedFileRequest } from "./file-edit-planner.js";
import { inferChartsFromTabularData, renderChartPng } from "./file-charts.js";
import { resolveFileEntry } from "./file-context-store.js";
import type { DatasetSummary } from "./dataset-extract.js";
import type { FileFormat, GeneratedFileResult, TabularData } from "./file-builder.js";
import type { FileEntry } from "./file-store.js";

type OfficeRawType = "docx" | "pptx" | "xlsx";

interface LayoutEditInput {
  message: string;
  format: FileFormat;
  documentRefs: string[];
  sessionId: string;
  userId?: string | null;
}

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
  return normalizePhrase(
    value
      .replace(/\b(?:and\s+)?(?:return|send|give)\s+(?:it|the file|the deck|the document).*$/i, "")
      .replace(/^["'â€œâ€]+|["'â€œâ€.,;:]+$/g, ""),
  );
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
  return xml.replace(
    /(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)/g,
    (full, open: string, _inner: string, close: string) => {
      const next =
        index === 0 ? insertion.title : bodyLines[Math.min(index - 1, bodyLines.length - 1)];
      index += 1;
      return `${open}${xmlEscape(next)}${close}`;
    },
  );
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

function buildOfficeResult(
  entry: FileEntry,
  type: OfficeRawType,
  buffer: Buffer,
  action: string,
): GeneratedFileResult {
  const slideCount =
    type === "pptx"
      ? Math.max(1, (entry.extractedText.match(/\bSlide\s+\d+:/gi) ?? []).length)
      : undefined;
  return {
    fileName: safeFileName(entry.filename, type),
    fileData: buffer.toString("base64"),
    mimeType: MIME_BY_TYPE[type],
    reply: `I've updated the original ${type.toUpperCase()} file (${action}) while preserving its existing layout where possible. Click the card below to download it.`,
    ...(type === "pptx" ? { slideCount } : {}),
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
  let changed = 0;
  workbook.eachSheet((sheet) => {
    const maxCol = Math.max(1, sheet.actualColumnCount || sheet.columnCount || 1);
    const headerRow = sheet.getRow(1);
    let exists = false;
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      if (normalizePhrase(cellText(cell.value)).toLowerCase() === header.toLowerCase()) {
        exists = true;
      }
    });
    if (exists) return;
    const nextCol = maxCol + 1;
    sheet.getCell(1, nextCol).value = header;
    sheet.getCell(1, nextCol).font = { ...(sheet.getCell(1, nextCol).font ?? {}), bold: true };
    for (let rowNumber = 2; rowNumber <= Math.max(sheet.actualRowCount, 2); rowNumber++) {
      sheet.getCell(rowNumber, nextCol).value = "";
    }
    changed += 1;
  });
  return changed;
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
  return {
    fileName: safeFileName(entry.filename, "xlsx"),
    fileData: buffer.toString("base64"),
    mimeType: MIME_BY_TYPE.xlsx,
    reply: `I've updated the original XLSX file (${actions.join("; ")}) while preserving the workbook where possible. Click the card below to download it.`,
    ...(entry.datasetSummary ? { rowCount: entry.datasetSummary.rowCount } : {}),
  };
}

async function resolveRawOfficeEntry(input: LayoutEditInput): Promise<FileEntry | null> {
  for (const ref of input.documentRefs) {
    const entry = await resolveFileEntry(ref, { sessionId: input.sessionId, userId: input.userId });
    if (!entry?.rawFileType || !entry.rawBase64) continue;
    if (entry.rawFileType === input.format) return entry;
  }
  return null;
}

export async function tryApplyLayoutPreservingFileEdit(
  input: LayoutEditInput,
): Promise<GeneratedFileResult | null> {
  if (input.format !== "docx" && input.format !== "pptx" && input.format !== "xlsx") return null;
  const entry = await resolveRawOfficeEntry(input);
  if (!entry) return null;
  if (entry.rawFileType === "pptx") return editPptx(entry, input.message);
  if (entry.rawFileType === "docx") return editDocx(entry, input.message);
  if (entry.rawFileType === "xlsx") return editXlsx(entry, input.message);
  return null;
}
