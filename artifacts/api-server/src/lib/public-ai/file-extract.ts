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

async function extractPptx(buffer: Buffer): Promise<string> {
  try {
    const officeparser = (await import("officeparser")).default;
    const text = await officeparser.parseOffice(buffer, { outputErrorToConsole: false });
    const trimmed = (typeof text === "string" ? text : "").trim();
    if (!trimmed) throw new ExtractionError("no-text");
    return truncateWithNote(trimmed);
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
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
  }
}
