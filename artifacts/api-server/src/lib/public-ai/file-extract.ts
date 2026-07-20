/**
 * Text extraction for Ora Phase 2.
 *
 * PDF  → pdf-parse
 * DOCX → mammoth
 * TXT  → safe UTF-8 buffer decode
 *
 * All parser errors are caught and re-thrown as a generic ExtractionError so
 * that no stack traces, file paths, or package internals reach the visitor.
 *
 * Raw file bytes are passed in and not retained after the call returns.
 */

import { MAX_TEXT_CHARS_PER_FILE } from "./file-store";
import type { AllowedFileType } from "./file-validate";
import { strFromU8, unzipSync } from "fflate";

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

function truncateWithNote(text: string): string {
  if (text.length <= MAX_TEXT_CHARS_PER_FILE) return text;
  const truncated = text.slice(0, MAX_TEXT_CHARS_PER_FILE);
  return (
    truncated +
    "\n\n[Note: This document is too long to analyze in full. The analysis above covers the first portion of the file.]"
  );
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    const text = (result.text ?? "").trim();
    if (!text) throw new ExtractionError("no-text");
    return truncateWithNote(text);
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(
      "This PDF could not be read. It may be encrypted, scanned without OCR, or corrupted.",
    );
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractStructuredPptxText(buffer: Buffer): string | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: (info) => /^ppt\/slides\/slide\d+\.xml$/i.test(info.name),
    });
  } catch {
    return null;
  }

  const slides = Object.entries(files)
    .map(([name, bytes]) => {
      const match = name.match(/slide(\d+)\.xml$/i);
      return {
        name,
        index: match ? Number.parseInt(match[1]!, 10) : Number.MAX_SAFE_INTEGER,
        xml: strFromU8(bytes),
      };
    })
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));

  // One line per PARAGRAPH (a:p), with the paragraph's runs joined, so the
  // text reads as whole sentences instead of spellcheck-fragmented runs. Text-
  // free slides are still emitted ("(no text)") so slide numbers always match
  // the deck's slide order — skipping them used to shift every later number.
  const blocks: string[] = [];
  let sawText = false;
  slides.forEach((slide, position) => {
    const paragraphs = [...slide.xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map((para) =>
        // Decode entities per run WITHOUT trimming (a trailing space in one
        // run is the separator before the next), join the runs, then collapse
        // whitespace once at the paragraph level.
        [...para[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
          .map((match) => decodeXmlEntities(match[1] ?? ""))
          .join("")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean);
    if (paragraphs.length === 0) {
      blocks.push(`Slide ${position + 1}: (no text)`);
      return;
    }
    sawText = true;
    blocks.push(`Slide ${position + 1}:\n${paragraphs.map((text) => `- ${text}`).join("\n")}`);
  });

  if (!sawText) return null;
  return [
    "[POWERPOINT STRUCTURE — slide text extracted from the uploaded deck]",
    "Use these slide numbers when the user asks to delete, rewrite, add, or reorder slides.",
    "",
    ...blocks,
  ].join("\n");
}

async function extractPptx(buffer: Buffer): Promise<string> {
  try {
    const structured = extractStructuredPptxText(buffer);
    if (structured) return truncateWithNote(structured);

    const officeparser = (await import("officeparser")).default;
    // officeparser v7 returns a structured AST (not a string). Call toText() to
    // get plain text. Older versions returned a string directly, so guard both.
    // The explicit fileType hint is required: buffer auto-detection fails in
    // the bundled server build (esbuild), even though it works unbundled.
    const parsed: unknown = await officeparser.parseOffice(buffer, { fileType: "pptx" });
    let text = "";
    if (typeof parsed === "string") {
      text = parsed;
    } else if (parsed && typeof (parsed as { toText?: unknown }).toText === "function") {
      text = (parsed as { toText: () => string }).toText();
    }
    const trimmed = text.trim();
    if (!trimmed) throw new ExtractionError("no-text");
    return truncateWithNote(trimmed);
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    const { logger } = await import("../logger");
    logger.error(
      { component: "ora-upload", err: err instanceof Error ? err.message : String(err) },
      "PPTX extraction failed",
    );
    throw new ExtractionError(
      "This PowerPoint file could not be read. It may be corrupted or use an unsupported format.",
    );
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value ?? "").trim();
    if (!text) throw new ExtractionError("no-text");
    return truncateWithNote(text);
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(
      "This Word document could not be read. It may be corrupted or use an unsupported format.",
    );
  }
}

async function extractZip(buffer: Buffer): Promise<string> {
  const { extractZipDigest, ZipExtractionError } = await import("./zip-extract");
  try {
    return truncateWithNote(extractZipDigest(buffer));
  } catch (err) {
    if (err instanceof ZipExtractionError) throw new ExtractionError(err.message);
    throw new ExtractionError(
      "This ZIP archive could not be read. It may be corrupted, encrypted, or use an unsupported compression format.",
    );
  }
}

function extractTxt(buffer: Buffer): string {
  try {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new ExtractionError("no-text");
    return truncateWithNote(text);
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(
      "This text file could not be read. Please ensure it is UTF-8 encoded.",
    );
  }
}

export async function extractText(
  buffer: Buffer,
  type: Exclude<AllowedFileType, "csv" | "xlsx">,
): Promise<string> {
  switch (type) {
    case "pdf":
      return extractPdf(buffer);
    case "docx":
      return extractDocx(buffer);
    case "txt":
      return extractTxt(buffer);
    case "pptx":
      return extractPptx(buffer);
    case "zip":
      return extractZip(buffer);
  }
}
