import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { DatasetSummary } from "../dataset-extract.js";
import type { storeFile as storeFileType } from "../file-store.js";
import type { tryApplyLayoutPreservingFileEdit as tryApplyLayoutPreservingFileEditType } from "../office-layout-edit.js";

let storeFile: typeof storeFileType;
let tryApplyLayoutPreservingFileEdit: typeof tryApplyLayoutPreservingFileEditType;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
  ({ storeFile } = await import("../file-store.js"));
  ({ tryApplyLayoutPreservingFileEdit } = await import("../office-layout-edit.js"));
});

function zipBase64(entries: Record<string, string>): string {
  return Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(entries).map(([path, xml]) => [path, strToU8(xml)])),
      { level: 1 },
    ),
  ).toString("base64");
}

function unzipBase64(base64: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(Buffer.from(base64, "base64")));
}

function makePptxBase64(): string {
  return zipBase64({
    "[Content_Types].xml": [
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
      "</Types>",
    ].join(""),
    "ppt/presentation.xml": [
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      "<p:sldIdLst>",
      '<p:sldId id="256" r:id="rId1"/>',
      '<p:sldId id="257" r:id="rId2"/>',
      "</p:sldIdLst>",
      "</p:presentation>",
    ].join(""),
    "ppt/_rels/presentation.xml.rels": [
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
      "</Relationships>",
    ].join(""),
    "ppt/slides/slide1.xml":
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:t>Old Pricing</a:t></p:spTree></p:cSld></p:sld>',
    "ppt/slides/slide2.xml":
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:t>Delete Me</a:t></p:spTree></p:cSld></p:sld>',
    "ppt/slides/_rels/slide2.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  });
}

function storeRawOffice(input: {
  sessionId: string;
  filename: string;
  rawFileType: "docx" | "pptx" | "xlsx";
  base64: string;
  extractedText?: string;
  datasetSummary?: DatasetSummary;
}): string {
  const mimeByType = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as const;
  return storeFile({
    sessionId: input.sessionId,
    filename: input.filename,
    mimeType: mimeByType[input.rawFileType],
    extractedText: input.extractedText ?? "",
    charCount: input.extractedText?.length ?? 0,
    datasetSummary: input.datasetSummary,
    rawBase64: input.base64,
    rawSizeBytes: Buffer.from(input.base64, "base64").length,
    rawFileType: input.rawFileType,
  });
}

describe("tryApplyLayoutPreservingFileEdit", () => {
  it("removes a requested PPTX slide from the original package", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Delete slide 2 and return the PowerPoint",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    const entries = unzipBase64(result!.fileData);
    expect(entries["ppt/slides/slide1.xml"]).toBeDefined();
    expect(entries["ppt/slides/slide2.xml"]).toBeUndefined();
    expect(entries["ppt/slides/_rels/slide2.xml.rels"]).toBeUndefined();
    expect(strFromU8(entries["ppt/presentation.xml"]!)).not.toContain("rId2");
    expect(strFromU8(entries["ppt/_rels/presentation.xml.rels"]!)).not.toContain("rId2");
    expect(strFromU8(entries["[Content_Types].xml"]!)).not.toContain("slide2.xml");
  });

  it("replaces text inside a PPTX slide without rebuilding the deck", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace "Old Pricing" with "Core vs Wave comparison" on slide 1',
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const slide1 = strFromU8(entries["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Core vs Wave comparison");
    expect(slide1).not.toContain("Old Pricing");
    expect(entries["ppt/slides/slide2.xml"]).toBeDefined();
  });

  it("handles natural PPTX section replacement requests without requiring quoted exact text", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Replace the pricing section with Core vs Wave comparison and send it back",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const slide1 = strFromU8(entries["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Core vs Wave comparison");
    expect(slide1).not.toContain("Old Pricing");
  });

  it("renames a PPTX slide title from natural slide-title wording", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Change slide 1 title to Executive Pricing Overview",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const slide1 = strFromU8(entries["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Executive Pricing Overview");
    expect(slide1).not.toContain("Old Pricing");
  });

  it("replaces text inside a DOCX while preserving the original package", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml":
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Old conclusion</w:t></w:r></w:p></w:body></w:document>',
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "quarterly-report.docx",
      rawFileType: "docx",
      base64,
      extractedText: "Old conclusion",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace "Old conclusion" with "The quarter closed ahead of plan"',
      format: "docx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const docXml = strFromU8(entries["word/document.xml"]!);
    expect(docXml).toContain("The quarter closed ahead of plan");
    expect(docXml).not.toContain("Old conclusion");
  });

  it("removes requested DOCX sections using natural remove wording", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml":
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Executive summary</w:t></w:r></w:p><w:p><w:r><w:t>Old conclusion</w:t></w:r></w:p></w:body></w:document>',
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "quarterly-report.docx",
      rawFileType: "docx",
      base64,
      extractedText: "Executive summary\nOld conclusion",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Remove the conclusion section and return the document",
      format: "docx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const docXml = strFromU8(entries["word/document.xml"]!);
    expect(docXml).toContain("Executive summary");
    expect(docXml).not.toContain("Old conclusion");
  });

  it("adds an Ora Charts worksheet to an uploaded XLSX workbook", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Revenue");
    sheet.addRow(["Region", "Revenue"]);
    sheet.addRow(["North", 120]);
    sheet.addRow(["South", 80]);
    sheet.addRow(["West", 150]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const datasetSummary: DatasetSummary = {
      rowCount: 3,
      colCount: 2,
      headers: ["Region", "Revenue"],
      sampleRows: [
        ["North", "120"],
        ["South", "80"],
        ["West", "150"],
      ],
      columnProfiles: [
        { index: 0, type: "string", nullCount: 0, uniqueCount: 3 },
        {
          index: 1,
          type: "numeric",
          nullCount: 0,
          uniqueCount: 3,
          min: 80,
          max: 150,
          mean: 116.67,
        },
      ],
      paretoSets: [],
      sanitizedCellCount: 0,
      hiddenSheetsSkipped: 0,
      truncated: false,
      sheetName: "Revenue",
    };
    const ref = storeRawOffice({
      sessionId,
      filename: "revenue.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
      datasetSummary,
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Add a bar chart dashboard for revenue by region",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(
      Buffer.from(result!.fileData, "base64") as unknown as Parameters<typeof out.xlsx.load>[0],
    );
    expect(out.getWorksheet("Revenue")).toBeDefined();
    const charts = out.getWorksheet("Ora Charts");
    expect(charts).toBeDefined();
    expect(charts?.getCell("A1").value).toBe("Ora generated charts");
    expect(charts?.getImages().length).toBeGreaterThanOrEqual(1);
  });

  it("adds real formula cells to an uploaded XLSX workbook", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Revenue");
    sheet.addRow(["Region", "Revenue"]);
    sheet.addRow(["North", 120]);
    sheet.addRow(["South", 80]);
    sheet.addRow(["West", 150]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const datasetSummary: DatasetSummary = {
      rowCount: 3,
      colCount: 2,
      headers: ["Region", "Revenue"],
      sampleRows: [
        ["North", "120"],
        ["South", "80"],
        ["West", "150"],
      ],
      columnProfiles: [
        { index: 0, type: "string", nullCount: 0, uniqueCount: 3 },
        {
          index: 1,
          type: "numeric",
          nullCount: 0,
          uniqueCount: 3,
          min: 80,
          max: 150,
          mean: 116.67,
        },
      ],
      paretoSets: [],
      sanitizedCellCount: 0,
      hiddenSheetsSkipped: 0,
      truncated: false,
      sheetName: "Revenue",
    };
    const ref = storeRawOffice({
      sessionId,
      filename: "revenue.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
      datasetSummary,
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Add formulas for total revenue, average revenue, and count",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(
      Buffer.from(result!.fileData, "base64") as unknown as Parameters<typeof out.xlsx.load>[0],
    );
    const calculations = out.getWorksheet("Ora Calculations");
    expect(calculations).toBeDefined();
    expect(calculations?.getCell("A2").value).toBe("Revenue total");
    expect((calculations?.getCell("C2").value as { formula?: string }).formula).toBe(
      "SUM('Revenue'!B2:B4)",
    );
    expect((calculations?.getCell("C3").value as { formula?: string }).formula).toBe(
      "AVERAGE('Revenue'!B2:B4)",
    );
  });

  it("deletes requested columns from an uploaded XLSX workbook", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pipeline");
    sheet.addRow(["Region", "Revenue", "Owner"]);
    sheet.addRow(["North", 120, "Alex"]);
    sheet.addRow(["South", 80, "Sam"]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const ref = storeRawOffice({
      sessionId,
      filename: "pipeline.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Delete the Owner column and return the Excel file",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(
      Buffer.from(result!.fileData, "base64") as unknown as Parameters<typeof out.xlsx.load>[0],
    );
    const edited = out.getWorksheet("Pipeline");
    expect(edited?.getCell("A1").value).toBe("Region");
    expect(edited?.getCell("B1").value).toBe("Revenue");
    expect(edited?.getCell("C1").value).toBeNull();
  });
});
