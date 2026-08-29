import { extname } from "node:path";
import { extractDataset } from "./public-ai/dataset-extract";
import { ExtractionError, extractText } from "./public-ai/file-extract";
import { validateFile } from "./public-ai/file-validate";

export const MAX_INLINE_ASSET_ANALYSIS_BYTES = 100 * 1024 * 1024;
const MAX_STORED_PREVIEW_CHARS = 100_000;

type AssetAnalysis =
  | { valid: true; textPreview: string | null; extractionUnavailable: boolean }
  | { valid: false; textPreview: null; extractionUnavailable: false };

function truncate(value: string): string {
  if (value.length <= MAX_STORED_PREVIEW_CHARS) return value;
  return `${value.slice(0, MAX_STORED_PREVIEW_CHARS)}\n\n[The stored analysis preview is truncated. Ask about a specific section to continue.]`;
}

function datasetPreview(summary: Awaited<ReturnType<typeof extractDataset>>): string {
  return truncate(
    JSON.stringify(
      {
        sheetName: summary.sheetName,
        otherVisibleSheets: summary.otherVisibleSheets,
        rowCount: summary.rowCount,
        colCount: summary.colCount,
        headers: summary.headers,
        sampleRows: summary.sampleRows,
        columnProfiles: summary.columnProfiles,
        paretoSets: summary.paretoSets,
        duplicateRows: summary.duplicateRows,
        hiddenSheetsSkipped: summary.hiddenSheetsSkipped,
        truncated: summary.truncated,
      },
      null,
      2,
    ),
  );
}

/**
 * Validates the complete stored bytes before marking an analyzable document ready.
 * Extraction failure does not destroy a valid upload: the file remains available and
 * Zero reports that its contents could not be read instead of inventing an analysis.
 */
export async function analyzeAssetBuffer(input: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<AssetAnalysis> {
  const extension = extname(input.filename).toLowerCase();
  if ([".txt", ".md", ".json"].includes(extension)) {
    const value = input.buffer.toString("utf8");
    if (value.includes("\ufffd") || value.includes("\u0000")) {
      return { valid: false, textPreview: null, extractionUnavailable: false };
    }
    return { valid: true, textPreview: truncate(value.trim()), extractionUnavailable: false };
  }

  if ([".pdf", ".docx", ".pptx", ".csv", ".xlsx"].includes(extension)) {
    const validated = validateFile(input.buffer, input.filename, input.mimeType);
    if (!validated.ok || validated.type === "zip") {
      return { valid: false, textPreview: null, extractionUnavailable: false };
    }
    try {
      if (validated.type === "csv" || validated.type === "xlsx") {
        return {
          valid: true,
          textPreview: datasetPreview(await extractDataset(input.buffer, validated.type)),
          extractionUnavailable: false,
        };
      }
      return {
        valid: true,
        textPreview: truncate(await extractText(input.buffer, validated.type)),
        extractionUnavailable: false,
      };
    } catch (error) {
      if (error instanceof ExtractionError || error instanceof Error) {
        return { valid: true, textPreview: null, extractionUnavailable: true };
      }
      throw error;
    }
  }

  return { valid: true, textPreview: null, extractionUnavailable: false };
}
