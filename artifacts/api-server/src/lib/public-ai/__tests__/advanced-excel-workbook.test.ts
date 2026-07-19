import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  buildTabularSystemPrompt,
  buildXlsx,
  hasUsableFileJson,
  normalizeTabularFileData,
} from "../file-builder.js";
import { detectFileRequest } from "../prompt.js";

function worksheetTableNames(worksheet: ExcelJS.Worksheet): string[] {
  const anyWorksheet = worksheet as unknown as {
    getTable?: (name: string) => { name?: string } | undefined;
    model?: { tables?: Array<{ name?: string }> };
    tables?: Record<string, { table?: { name?: string }; name?: string }>;
  };
  const fromModel = anyWorksheet.model?.tables?.map((table) => table.name).filter(Boolean) ?? [];
  const fromObject = Object.values(anyWorksheet.tables ?? {})
    .map((entry) => entry.table?.name ?? entry.name)
    .filter(Boolean);
  const known = ["InputsTable", "SummaryTable", "Items", "AppSheetSetup", "AppSheetTables"].filter(
    (name) => anyWorksheet.getTable?.(name),
  );
  return [...fromModel, ...fromObject, ...known] as string[];
}

describe("advanced Excel workbook generation", () => {
  it("builds multi-sheet workbooks with real Excel tables and formula cells", async () => {
    const data = normalizeTabularFileData({
      title: "Store Revenue Model",
      sheets: [
        {
          sheetName: "Inputs",
          headers: ["Product", "Units", "Unit Price"],
          columnTypes: ["text", "number", "currency"],
          rows: [
            ["Starter", "10", "12.50"],
            ["Pro", "5", "30.00"],
          ],
          tableName: "InputsTable",
        },
        {
          sheetName: "Summary",
          headers: ["Metric", "Value"],
          rows: [["Total Revenue", ""]],
          tableName: "SummaryTable",
          formulas: [
            {
              cell: "B2",
              formula: "SUM(Inputs!C2:C3)",
              result: "42.5",
              numFmt: "$#,##0.00",
            },
          ],
        },
      ],
    });

    const buffer = await buildXlsx(data);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    const inputs = workbook.getWorksheet("Inputs");
    const summary = workbook.getWorksheet("Summary");
    expect(inputs).toBeTruthy();
    expect(summary).toBeTruthy();
    expect(worksheetTableNames(inputs!)).toContain("InputsTable");
    expect(worksheetTableNames(summary!)).toContain("SummaryTable");
    const formulaValue = summary!.getCell("B2").value as { formula?: string; result?: unknown };
    expect(formulaValue.formula).toBe("SUM(Inputs!C2:C3)");
    expect(formulaValue.result).toBe(42.5);
    expect(summary!.getCell("B2").numFmt).toBe("$#,##0.00");
  });

  it("creates AppSheet-ready workbook tabs even when the starter data tables are empty", async () => {
    const data = normalizeTabularFileData({
      title: "Field Inspection App",
      appSheet: {
        appName: "Field Inspection App",
        summary: "Inspect sites, assign follow-ups, and track completion.",
        tables: [
          {
            name: "Inspections",
            purpose: "Capture site inspection records",
            keyColumn: "Inspection ID",
            columns: [
              { name: "Inspection ID", type: "Text", required: true },
              { name: "Site", type: "Text", required: true },
              { name: "Inspection Date", type: "Date" },
              { name: "Risk Score", type: "Number" },
            ],
          },
        ],
        views: [{ name: "Open Inspections", table: "Inspections", type: "Table" }],
      },
    });

    expect(
      hasUsableFileJson({ title: "Field Inspection App", appSheet: data.appSheet }, "xlsx"),
    ).toBe(true);

    const buffer = await buildXlsx(data);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    expect(workbook.getWorksheet("Inspections")).toBeTruthy();
    expect(workbook.getWorksheet("AppSheet Setup")).toBeTruthy();
    expect(workbook.getWorksheet("AppSheet Tables")).toBeTruthy();
    expect(workbook.getWorksheet("AppSheet Setup")!.getCell("B2").value).toBe(
      "Field Inspection App",
    );
  });

  it("teaches the model the advanced workbook schema", () => {
    const prompt = buildTabularSystemPrompt("xlsx");
    expect(prompt).toContain('"sheets"');
    expect(prompt).toContain('"formulas"');
    expect(prompt).toContain('"appSheet"');
    expect(prompt).toContain("AppSheet-ready XLSX workbook");
    expect(prompt).toContain("never write formulas as plain text");
  });

  it("routes AppSheet app requests to XLSX file generation without hijacking generic apps", () => {
    expect(detectFileRequest("Build an AppSheet inventory app from scratch")).toBe("xlsx");
    expect(detectFileRequest("Create an app sheet app for field inspections")).toBe("xlsx");
    expect(detectFileRequest("Build a mobile app for field inspections")).toBeNull();
  });
});
