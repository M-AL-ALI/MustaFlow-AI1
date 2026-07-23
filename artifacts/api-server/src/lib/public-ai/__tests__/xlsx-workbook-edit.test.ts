/**
 * Phase 10 XLSX Workbook Edit — regression tests.
 *
 * Ensures that structured workbook operations (formulas, charts, header styles)
 * route correctly through editXlsx rather than falling through to the AI text
 * planner, which previously produced the wrong "couldn't locate exact text"
 * failure message for non-text requests.
 *
 * Test matrix:
 * 1. Formula intent WITH datasetSummary → Ora Calculations worksheet added.
 * 2. Formula intent WITHOUT datasetSummary → auto-derived summary, worksheet added.
 * 3. Chart intent WITH datasetSummary → Ora Charts worksheet added.
 * 4. Header-style intent → cells in row 1 get bold font + blue fill.
 * 5. Text replacement → cell text updated (text planner path is valid for text ops).
 * 6. Workbook op with no numeric columns → workbook-specific failure, NOT "exact text".
 */

import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DatasetSummary } from "../dataset-extract.js";
import type { storeFile as storeFileType } from "../file-store.js";
import type { tryApplyLayoutPreservingFileEdit as tryApplyLayoutPreservingFileEditType } from "../office-layout-edit.js";

vi.mock("../office-ai-edit.js", () => ({
  planAiOfficeEditOps: vi.fn(async () => null),
}));

let storeFile: typeof storeFileType;
let tryApplyLayoutPreservingFileEdit: typeof tryApplyLayoutPreservingFileEditType;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
  ({ storeFile } = await import("../file-store.js"));
  ({ tryApplyLayoutPreservingFileEdit } = await import("../office-layout-edit.js"));
});

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function makeNumericXlsx(): Promise<{ base64: string; datasetSummary: DatasetSummary }> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Operations");
  sheet.addRow(["Equipment", "Downtime (hrs)", "Waste (%)"]);
  sheet.addRow(["Press A", 4.5, 12]);
  sheet.addRow(["Press B", 2.0, 7]);
  sheet.addRow(["Press C", 6.0, 18]);
  const raw = Buffer.from(await wb.xlsx.writeBuffer());
  const datasetSummary: DatasetSummary = {
    rowCount: 3,
    colCount: 3,
    headers: ["Equipment", "Downtime (hrs)", "Waste (%)"],
    sampleRows: [
      ["Press A", "4.5", "12"],
      ["Press B", "2.0", "7"],
      ["Press C", "6.0", "18"],
    ],
    columnProfiles: [
      { index: 0, type: "string", nullCount: 0, uniqueCount: 3 },
      { index: 1, type: "numeric", nullCount: 0, uniqueCount: 3, min: 2.0, max: 6.0, mean: 4.17 },
      { index: 2, type: "numeric", nullCount: 0, uniqueCount: 3, min: 7, max: 18, mean: 12.33 },
    ],
    paretoSets: [],
    sanitizedCellCount: 0,
    hiddenSheetsSkipped: 0,
    truncated: false,
    sheetName: "Operations",
  };
  return { base64: raw.toString("base64"), datasetSummary };
}

async function makeNumericXlsxNoSummary(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Operations");
  sheet.addRow(["Equipment", "Downtime (hrs)", "Waste (%)"]);
  sheet.addRow(["Press A", 4.5, 12]);
  sheet.addRow(["Press B", 2.0, 7]);
  sheet.addRow(["Press C", 6.0, 18]);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

async function makeTextOnlyXlsx(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Status");
  sheet.addRow(["Equipment", "Status", "Notes"]);
  sheet.addRow(["Press A", "Running", "OK"]);
  sheet.addRow(["Press B", "Stopped", "Needs repair"]);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

async function makeTextXlsxWithOldStatus(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Status");
  sheet.addRow(["Equipment", "Status"]);
  sheet.addRow(["Press A", "Old Status"]);
  sheet.addRow(["Press B", "Old Status"]);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

function storeXlsx(
  sessionId: string,
  filename: string,
  base64: string,
  datasetSummary?: DatasetSummary,
): string {
  return storeFile({
    sessionId,
    filename,
    mimeType: XLSX_MIME,
    extractedText: "",
    charCount: 0,
    datasetSummary,
    rawBase64: base64,
    rawSizeBytes: Buffer.from(base64, "base64").length,
    rawFileType: "xlsx",
  });
}

async function loadWorkbookFromResult(fileData: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    Buffer.from(fileData, "base64") as unknown as Parameters<typeof wb.xlsx.load>[0],
  );
  return wb;
}

describe("XLSX workbook edit — Phase 10 structured operation routing", () => {
  it("1. formula intent WITH datasetSummary adds Ora Calculations worksheet", async () => {
    const sessionId = crypto.randomUUID();
    const { base64, datasetSummary } = await makeNumericXlsx();
    const ref = storeXlsx(sessionId, "operations.xlsx", base64, datasetSummary);

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Add formulas for total downtime and waste percentage",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe(XLSX_MIME);
    const out = await loadWorkbookFromResult(result!.fileData);
    const calc = out.getWorksheet("Ora Calculations");
    expect(calc).toBeDefined();
    const metricA2 = calc?.getCell("A2").value;
    expect(String(metricA2)).toMatch(/downtime/i);
    const formulaC2 = (calc?.getCell("C2").value as { formula?: string } | null)?.formula;
    expect(formulaC2).toMatch(/SUM/i);
    expect(result!.editQuality?.editMode).toBe("original_edited");
  });

  it("2. formula intent WITHOUT datasetSummary auto-derives summary and adds Ora Calculations worksheet", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = await makeNumericXlsxNoSummary();
    const ref = storeXlsx(sessionId, "operations.xlsx", base64);

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Add formulas for total downtime and waste percentage",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = await loadWorkbookFromResult(result!.fileData);
    const calc = out.getWorksheet("Ora Calculations");
    expect(calc).toBeDefined();
    expect(result!.editQuality?.editMode).toBe("original_edited");
  });

  it("3. chart intent WITH datasetSummary adds Ora Charts worksheet with images", async () => {
    const sessionId = crypto.randomUUID();
    const { base64, datasetSummary } = await makeNumericXlsx();
    const ref = storeXlsx(sessionId, "operations.xlsx", base64, datasetSummary);

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Create a histogram/chart from the downtime column",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = await loadWorkbookFromResult(result!.fileData);
    const charts = out.getWorksheet("Ora Charts");
    expect(charts).toBeDefined();
    expect(charts?.getImages().length).toBeGreaterThanOrEqual(1);
    expect(result!.editQuality?.editMode).toBe("original_edited");
  });

  it("4. header-style intent applies bold font and blue fill to row-1 header cells", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = await makeNumericXlsxNoSummary();
    const ref = storeXlsx(sessionId, "operations.xlsx", base64);

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Format the headers blue and bold",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = await loadWorkbookFromResult(result!.fileData);
    const sheet = out.getWorksheet("Operations");
    expect(sheet).toBeDefined();
    const header1 = sheet?.getCell("A1");
    expect(header1?.font?.bold).toBe(true);
    const fill = header1?.fill as { fgColor?: { argb?: string } } | undefined;
    expect(fill?.fgColor?.argb).toMatch(/0070C0/i);
    expect(result!.editQuality?.editMode).toBe("original_edited");
  });

  it("5. text-replacement intent updates matching cells (text-location path is valid for text ops)", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = await makeTextXlsxWithOldStatus();
    const ref = storeXlsx(sessionId, "status.xlsx", base64);

    const result = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace "Old Status" with "New Status" in the spreadsheet',
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = await loadWorkbookFromResult(result!.fileData);
    const sheet = out.getWorksheet("Status");
    expect(sheet?.getCell("B2").value).toBe("New Status");
    expect(sheet?.getCell("B3").value).toBe("New Status");
  });

  it("6. workbook op failure returns operation-specific message, NOT 'exact text' wording", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = await makeTextOnlyXlsx();
    const ref = storeXlsx(sessionId, "status.xlsx", base64);

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Add formulas for total downtime and waste percentage",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(result!.reply).not.toMatch(/exact text/i);
    expect(result!.reply).not.toMatch(/locate.*text/i);
    const warning = result!.editQuality?.warning ?? "";
    expect(warning).not.toMatch(/exact text/i);
    expect(result!.editQuality?.editMode).toBe("failed_safe");
    expect(result!.reply).toMatch(/numeric|column|formula|workbook/i);
  });
});
