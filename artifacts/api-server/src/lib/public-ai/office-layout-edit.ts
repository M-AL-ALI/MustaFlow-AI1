import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
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

function shortenText(value: string): string | null {
  const clean = normalizePhrase(value);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 12 && clean.length < 90) return null;
  const shortened = words.slice(0, 18).join(" ");
  return shortened.length < clean.length ? `${shortened}...` : null;
}

function replaceTextNodes(
  xml: string,
  nodeName: "a:t" | "w:t",
  replacement: TextReplacement,
): { xml: string; count: number } {
  const oldNorm = normalizePhrase(replacement.oldText);
  const oldRegex = new RegExp(escapeRegExp(oldNorm), "i");
  const keywords = oldNorm
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
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

function shortenPptxSlide(entries: ZipEntries, slideNumber: number): number {
  const slide = slideOrder(entries)[slideNumber - 1];
  if (!slide) return 0;
  const xml = getXml(entries, slide.path);
  if (!xml) return 0;
  const updated = shortenTextNodes(xml);
  if (updated.count > 0) setXml(entries, slide.path, updated.xml);
  return updated.count;
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
  const deleteSlide = parseDeleteSlide(message);
  if (deleteSlide) {
    const changed = deletePptxSlide(entries, deleteSlide);
    if (changed > 0) {
      return buildOfficeResult(entry, "pptx", zipBuffer(entries), `removed slide ${deleteSlide}`);
    }
  }

  const replacement = parseTextReplacement(message);
  if (replacement) {
    const changed = replacePptxText(entries, replacement);
    if (changed > 0) {
      return buildOfficeResult(
        entry,
        "pptx",
        zipBuffer(entries),
        `replaced "${replacement.oldText}"`,
      );
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

  return null;
}

async function editDocx(entry: FileEntry, message: string): Promise<GeneratedFileResult | null> {
  const raw = base64Raw(entry);
  const replacement = parseTextReplacement(message);
  if (!raw || !replacement) return null;
  const entries = unzipSync(new Uint8Array(raw));
  const docXml = getXml(entries, "word/document.xml");
  if (!docXml) return null;
  const updated = replaceTextNodes(docXml, "w:t", replacement);
  if (updated.count === 0) return null;
  setXml(entries, "word/document.xml", updated.xml);
  return buildOfficeResult(entry, "docx", zipBuffer(entries), `replaced "${replacement.oldText}"`);
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

async function editXlsx(entry: FileEntry, message: string): Promise<GeneratedFileResult | null> {
  if (!hasChartIntent(message) || !entry.datasetSummary) return null;
  const raw = base64Raw(entry);
  if (!raw) return null;
  const data = tabularDataFromSummary(entry, entry.datasetSummary);
  const charts = inferChartsFromTabularData(data, message, 3);
  if (charts.length === 0) return null;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as Parameters<typeof workbook.xlsx.load>[0]);
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
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    fileName: safeFileName(entry.filename, "xlsx"),
    fileData: buffer.toString("base64"),
    mimeType: MIME_BY_TYPE.xlsx,
    reply:
      "I've added an Ora Charts worksheet to your original Excel workbook with generated charts and source values. Click the card below to download it.",
    rowCount: entry.datasetSummary.rowCount,
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
