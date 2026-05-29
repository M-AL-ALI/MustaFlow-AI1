/**
 * File validation for Ora Phase 2 (PDF/DOCX/TXT) + Phase 3 (CSV/XLSX).
 *
 * Two-layer check for documents: magic bytes + structure scan.
 * Three-layer check for XLSX: magic bytes + OOXML structure scan + ZIP entry count (done in extract).
 * One-layer check for CSV: extension guard + plain-text heuristic.
 *
 * Blocked legacy/macro spreadsheet formats: .xls, .xlsm, .xlsb, .ods
 */

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".sh",
  ".bash",
  ".bat",
  ".cmd",
  ".ps1",
  ".msi",
  ".dll",
  ".app",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".rb",
  ".php",
  ".go",
  ".rs",
  ".java",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".rar",
  ".7z",
  ".xz",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".tiff",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".flac",
  ".ogg",
  ".xls",
  ".xlsm",
  ".xlsb",
  ".ods",
  ".pptx",
  ".ppt",
  ".odp",
  ".html",
  ".htm",
  ".xml",
  ".json",
  ".yaml",
  ".yml",
  ".db",
  ".sqlite",
  ".sql",
]);

export type AllowedFileType = "pdf" | "docx" | "txt" | "csv" | "xlsx";

export type ValidationResult =
  | { ok: true; type: AllowedFileType; sanitizedName: string }
  | { ok: false; statusCode: 413 | 415 | 422; error: string };

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._\- ]/g, "_")
      .replace(/\.{2,}/g, "_")
      .slice(0, 100)
      .trim() || "upload"
  );
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function checkMagicBytes(buffer: Buffer): "pdf" | "zip" | "unknown" {
  if (buffer.length < 4) return "unknown";
  const b = buffer;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "zip";
  return "unknown";
}

/**
 * Verify DOCX structure: ZIP must contain word/ entries and [Content_Types].xml.
 */
function hasDocxStructure(buffer: Buffer): boolean {
  const raw = buffer.toString("latin1");
  const hasWord = raw.includes("word/document.xml") || raw.includes("word/");
  const hasContentTypes = raw.includes("[Content_Types].xml");
  return hasWord && hasContentTypes;
}

/**
 * Verify XLSX structure: ZIP must contain xl/workbook.xml and [Content_Types].xml.
 */
function hasXlsxStructure(buffer: Buffer): boolean {
  const raw = buffer.toString("latin1");
  const hasWorkbook = raw.includes("xl/workbook.xml") || raw.includes("xl/");
  const hasContentTypes = raw.includes("[Content_Types].xml");
  return hasWorkbook && hasContentTypes;
}

function looksLikePlainText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.slice(0, Math.min(buffer.length, 4096));
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      printable++;
    }
  }
  return printable / sample.length >= 0.85;
}

export function validateFile(
  buffer: Buffer,
  originalFilename: string,
  _declaredMimeType: string,
): ValidationResult {
  if (buffer.length > MAX_FILE_SIZE) {
    return {
      ok: false,
      statusCode: 413,
      error: `File exceeds the 10 MB limit (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Please upload a smaller file.`,
    };
  }

  const ext = getExtension(originalFilename);

  if (BLOCKED_EXTENSIONS.has(ext)) {
    const spreadsheetBlocked = new Set([".xls", ".xlsm", ".xlsb", ".ods"]);
    if (spreadsheetBlocked.has(ext)) {
      return {
        ok: false,
        statusCode: 415,
        error: `File type "${ext}" is not supported. Please convert your spreadsheet to .xlsx or .csv format and try again.`,
      };
    }
    return {
      ok: false,
      statusCode: 415,
      error: `File type "${ext}" is not supported. Ora accepts PDF, DOCX, TXT, CSV, and XLSX files.`,
    };
  }

  const sanitizedName = sanitizeFilename(originalFilename);
  const magic = checkMagicBytes(buffer);

  if (ext === ".pdf") {
    if (magic !== "pdf") {
      return {
        ok: false,
        statusCode: 415,
        error: "This file does not appear to be a valid PDF. Please upload a genuine PDF file.",
      };
    }
    return { ok: true, type: "pdf", sanitizedName };
  }

  if (ext === ".docx") {
    if (magic !== "zip") {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This file does not appear to be a valid DOCX. Please upload a genuine Word document.",
      };
    }
    if (!hasDocxStructure(buffer)) {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This ZIP file does not contain a valid Word document structure. Please upload a genuine .docx file.",
      };
    }
    return { ok: true, type: "docx", sanitizedName };
  }

  if (ext === ".xlsx") {
    if (magic !== "zip") {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This file does not appear to be a valid XLSX. Please upload a genuine Excel .xlsx file.",
      };
    }
    if (!hasXlsxStructure(buffer)) {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This ZIP file does not contain a valid Excel structure. Please upload a genuine .xlsx file.",
      };
    }
    return { ok: true, type: "xlsx", sanitizedName };
  }

  if (ext === ".csv") {
    if (magic === "pdf" || magic === "zip") {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This file's content does not match a CSV file. Please upload a plain-text CSV file.",
      };
    }
    if (!looksLikePlainText(buffer)) {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This file does not appear to contain readable text. Please upload a valid CSV file.",
      };
    }
    return { ok: true, type: "csv", sanitizedName };
  }

  if (ext === ".txt") {
    if (magic === "pdf" || magic === "zip") {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This file's content does not match a plain text file. Please upload a genuine .txt file.",
      };
    }
    if (!looksLikePlainText(buffer)) {
      return {
        ok: false,
        statusCode: 415,
        error:
          "This file does not appear to contain readable text. Please upload a plain text (.txt) file.",
      };
    }
    return { ok: true, type: "txt", sanitizedName };
  }

  return {
    ok: false,
    statusCode: 415,
    error: `Unsupported file type "${ext || "(none)"}". Ora accepts PDF, DOCX, TXT, CSV, and XLSX files.`,
  };
}
