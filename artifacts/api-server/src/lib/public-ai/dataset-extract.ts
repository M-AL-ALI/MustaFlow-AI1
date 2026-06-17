/**
 * Dataset extraction for Ora Phase 3.
 *
 * Parses CSV and XLSX files into a DatasetSummary containing column profiles,
 * a reservoir sample of rows, and Pareto pre-computations. All computation is
 * done server-side from the full dataset (up to MAX_DATASET_ROWS cap).
 *
 * Safety:
 * - Formula cells in XLSX use the cached result value, never the formula string.
 * - All cell values pass through sanitiseCell (control chars + formula neutralisation).
 * - Hidden XLSX worksheets are skipped entirely.
 * - ZIP entry count guard applied before ExcelJS parse.
 * - Parse wrapped in a 10-second timeout Promise.race.
 *
 * Nothing is logged in this module.
 */

import { sanitiseCell } from "./dataset-safety.js";
import { computeColumnProfiles, computePareto, computeDuplicateRowStats } from "./dataset-stats.js";
import type { ColumnProfile, ParetoSet, DuplicateRowStats } from "./dataset-stats.js";

export const MAX_DATASET_ROWS = 10_000;
export const MAX_DATASET_COLS = 200;
export const DATASET_SAMPLE_SIZE = 500;
const ZIP_ENTRY_LIMIT = 500;
const PARSE_TIMEOUT_MS = 10_000;

export interface DatasetSummary {
  rowCount: number;
  colCount: number;
  headers: string[];
  sampleRows: string[][];
  columnProfiles: ColumnProfile[];
  paretoSets: ParetoSet[];
  duplicateRows?: DuplicateRowStats;
  sanitizedCellCount: number;
  hiddenSheetsSkipped: number;
  truncated: boolean;
  sheetName?: string;
  // Names of other visible sheets we did NOT extract (the workbook had more
  // than one sheet with data). Surfaced to the user so a multi-sheet upload is
  // never silently reduced to a single sheet without them knowing.
  otherVisibleSheets?: string[];
}

export class DatasetExtractionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DatasetExtractionError";
  }
}

/**
 * Read the ZIP End-of-Central-Directory record and return the total entry count,
 * or null if the EOCD cannot be found (e.g. corrupted or truncated file).
 */
function countZipEntries(buf: Buffer): number | null {
  const EOCD_SIG = [0x50, 0x4b, 0x05, 0x06] as const;
  const minOffset = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (
      buf[i] === EOCD_SIG[0] &&
      buf[i + 1] === EOCD_SIG[1] &&
      buf[i + 2] === EOCD_SIG[2] &&
      buf[i + 3] === EOCD_SIG[3]
    ) {
      if (i + 22 > buf.length) return null;
      return buf.readUInt16LE(i + 10);
    }
  }
  return null;
}

/**
 * Reservoir sampling using Algorithm R.
 * Returns a random sample of up to `size` rows, preserving row order.
 */
function reservoirSample(rows: string[][], size: number): string[][] {
  if (rows.length <= size) return rows;
  const reservoir = rows.slice(0, size);
  for (let i = size; i < rows.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < size) {
      reservoir[j] = rows[i]!;
    }
  }
  return reservoir;
}

function normalizeHeader(raw: string, colIndex: number): string {
  const trimmed = raw.trim();
  return trimmed !== "" ? trimmed : `Column${colIndex + 1}`;
}

async function extractCsv(buffer: Buffer): Promise<DatasetSummary> {
  const { parse } = await import("csv-parse/sync");

  let records: string[][];
  try {
    records = parse(buffer, {
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
      cast: false,
      encoding: "utf8",
    }) as string[][];
  } catch {
    throw new DatasetExtractionError("csv-parse-failed", "This CSV file could not be parsed.");
  }

  if (records.length === 0) {
    throw new DatasetExtractionError("empty", "The CSV file appears to be empty.");
  }

  const [headerRow, ...dataRows] = records;
  const rawHeaders = (headerRow ?? []).slice(0, MAX_DATASET_COLS);
  const headers = rawHeaders.map((h, i) => {
    const { value } = sanitiseCell(normalizeHeader(String(h ?? ""), i));
    return value;
  });
  const colCount = headers.length;

  if (dataRows.length === 0) {
    throw new DatasetExtractionError(
      "empty",
      "The CSV file contains only a header row with no data.",
    );
  }

  const truncated = dataRows.length > MAX_DATASET_ROWS;
  const cappedRows = dataRows.slice(0, MAX_DATASET_ROWS);

  let sanitizedCellCount = 0;
  const allRows: string[][] = cappedRows.map((row) => {
    const result: string[] = [];
    for (let ci = 0; ci < colCount; ci++) {
      const raw = String(row[ci] ?? "");
      const { value, sanitized } = sanitiseCell(raw);
      if (sanitized) sanitizedCellCount++;
      result.push(value);
    }
    return result;
  });

  const columnProfiles = computeColumnProfiles(headers, allRows);
  const paretoSets = computePareto(headers, allRows, columnProfiles);
  const duplicateRows = computeDuplicateRowStats(headers, allRows);
  const sampleRows = reservoirSample(allRows, DATASET_SAMPLE_SIZE);

  return {
    rowCount: allRows.length,
    colCount,
    headers,
    sampleRows,
    columnProfiles,
    paretoSets,
    duplicateRows,
    sanitizedCellCount,
    hiddenSheetsSkipped: 0,
    truncated,
  };
}

async function extractXlsx(buffer: Buffer): Promise<DatasetSummary> {
  const entryCount = countZipEntries(buffer);
  if (entryCount !== null && entryCount > ZIP_ENTRY_LIMIT) {
    throw new DatasetExtractionError(
      "too-many-zip-entries",
      "This XLSX file is too complex to analyze (too many internal entries).",
    );
  }

  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();

  try {
    await Promise.race([
      // ExcelJS 4.x expects its own Buffer type; cast via unknown to satisfy TS 5.9+
      workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("parse-timeout")), PARSE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    if ((err as Error).message === "parse-timeout") {
      throw new DatasetExtractionError(
        "parse-timeout",
        "The XLSX file took too long to parse. Please try a smaller file.",
      );
    }
    throw new DatasetExtractionError(
      "xlsx-parse-failed",
      "This XLSX file could not be parsed. Please ensure it is a valid .xlsx file.",
    );
  }

  // ExcelJS 4.x worksheets[0] resolves to `never` in strict TS 5.9+ generics; use `any` locally
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let targetSheet: any = null;
  let targetRowCount = -1;
  let hiddenSheetsSkipped = 0;
  const visibleSheetNames: string[] = [];

  // Pick the LARGEST visible sheet (most rows) rather than the first one. A
  // common layout puts a cover/instructions tab first and the real data on a
  // later sheet; selecting the first sheet silently dropped that data.
  workbook.eachSheet((sheet) => {
    const state = (sheet as { state?: string }).state;
    if (state === "hidden" || state === "veryHidden") {
      hiddenSheetsSkipped++;
      return;
    }
    const name = (sheet as { name?: string }).name ?? "Sheet";
    visibleSheetNames.push(name);
    const rowCount =
      (sheet as { actualRowCount?: number; rowCount?: number }).actualRowCount ??
      (sheet as { rowCount?: number }).rowCount ??
      0;
    if (rowCount > targetRowCount) {
      targetRowCount = rowCount;
      targetSheet = sheet;
    }
  });

  if (!targetSheet) {
    throw new DatasetExtractionError(
      "no-visible-sheet",
      "This XLSX file has no visible worksheets.",
    );
  }

  const sheet = targetSheet;
  const sheetName = (sheet as { name?: string }).name ?? "Sheet1";
  const otherVisibleSheets = visibleSheetNames.filter((n) => n !== sheetName);

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell: { value: unknown }, colNumber: number) => {
    if (headers.length < MAX_DATASET_COLS) {
      const raw = String(cell.value ?? "").trim();
      const { value } = sanitiseCell(normalizeHeader(raw, colNumber - 1));
      headers.push(value);
    }
  });

  if (headers.length === 0) {
    throw new DatasetExtractionError(
      "no-headers",
      "This XLSX file appears to be empty or has no column headers.",
    );
  }

  const colCount = headers.length;
  const allRows: string[][] = [];
  let sanitizedCellCount = 0;
  let truncated = false;

  sheet.eachRow(
    { includeEmpty: false },
    (row: { getCell: (n: number) => { value: unknown } }, rowNumber: number) => {
      if (rowNumber === 1) return;
      if (allRows.length >= MAX_DATASET_ROWS) {
        truncated = true;
        return;
      }

      const rowData: string[] = [];
      for (let ci = 1; ci <= colCount; ci++) {
        const cell = row.getCell(ci);
        // eslint-disable-next-line no-useless-assignment
        let rawValue = "";

        const cellVal = cell.value;
        if (cellVal === null || cellVal === undefined) {
          rawValue = "";
        } else if (
          typeof cellVal === "object" &&
          cellVal !== null &&
          "formula" in (cellVal as object)
        ) {
          const formulaCell = cellVal as { formula?: string; result?: unknown };
          const result = formulaCell.result;
          if (result === null || result === undefined) {
            rawValue = "";
          } else if (typeof result === "object" && result !== null && "error" in result) {
            rawValue = "";
          } else {
            rawValue = String(result);
          }
        } else if (typeof cellVal === "object" && cellVal instanceof Date) {
          rawValue = cellVal.toISOString().slice(0, 10);
        } else {
          rawValue = String(cellVal);
        }

        const { value, sanitized } = sanitiseCell(rawValue);
        if (sanitized) sanitizedCellCount++;
        rowData.push(value);
      }
      allRows.push(rowData);
    },
  );

  if (allRows.length === 0) {
    throw new DatasetExtractionError("empty", "This XLSX file has no data rows.");
  }

  const columnProfiles = computeColumnProfiles(headers, allRows);
  const paretoSets = computePareto(headers, allRows, columnProfiles);
  const duplicateRows = computeDuplicateRowStats(headers, allRows);
  const sampleRows = reservoirSample(allRows, DATASET_SAMPLE_SIZE);

  return {
    rowCount: allRows.length,
    colCount,
    headers,
    sampleRows,
    columnProfiles,
    paretoSets,
    duplicateRows,
    sanitizedCellCount,
    hiddenSheetsSkipped,
    truncated,
    sheetName,
    otherVisibleSheets: otherVisibleSheets.length > 0 ? otherVisibleSheets : undefined,
  };
}

export async function extractDataset(
  buffer: Buffer,
  type: "csv" | "xlsx",
): Promise<DatasetSummary> {
  if (type === "csv") return extractCsv(buffer);
  return extractXlsx(buffer);
}
