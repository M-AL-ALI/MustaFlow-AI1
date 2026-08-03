import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatasetSummary } from "../dataset-extract.js";
import type { storeFile as storeFileType } from "../file-store.js";
import type { AiOfficeEditPlan } from "../office-ai-edit.js";
import type { tryApplyLayoutPreservingFileEdit as tryApplyLayoutPreservingFileEditType } from "../office-layout-edit.js";

// Controls the mocked AI edit planner. Default null = "planner unavailable",
// which preserves legacy behavior for all pre-existing tests in this file.
const aiPlanner = vi.hoisted(() => ({
  plan: null as AiOfficeEditPlan | null,
  calls: [] as unknown[],
}));

vi.mock("../office-ai-edit.js", () => ({
  planAiOfficeEditOps: vi.fn(async (input: unknown) => {
    aiPlanner.calls.push(input);
    return aiPlanner.plan;
  }),
}));

let storeFile: typeof storeFileType;
let tryApplyLayoutPreservingFileEdit: typeof tryApplyLayoutPreservingFileEditType;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
  ({ storeFile } = await import("../file-store.js"));
  ({ tryApplyLayoutPreservingFileEdit } = await import("../office-layout-edit.js"));
});

afterEach(() => {
  aiPlanner.plan = null;
  aiPlanner.calls = [];
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

function makePptxBase64WithSlideText(text: string): string {
  return zipBase64({
    "[Content_Types].xml": [
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
      "</Types>",
    ].join(""),
    "ppt/presentation.xml": [
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      "<p:sldIdLst>",
      '<p:sldId id="256" r:id="rId1"/>',
      "</p:sldIdLst>",
      "</p:presentation>",
    ].join(""),
    "ppt/_rels/presentation.xml.rels": [
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
      "</Relationships>",
    ].join(""),
    "ppt/slides/slide1.xml": `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:t>${text}</a:t></p:spTree></p:cSld></p:sld>`,
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

  it("moves PPTX slides from natural reorder wording", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Move slide 2 before slide 1 and return the PowerPoint",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const presentationXml = strFromU8(entries["ppt/presentation.xml"]!);
    expect(presentationXml.indexOf('r:id="rId2"')).toBeLessThan(
      presentationXml.indexOf('r:id="rId1"'),
    );
  });

  it("adds a new PPTX slide while preserving the original package", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message:
        "Add a slide after slide 1 titled Product Roadmap with bullets Launch; Measure; Improve",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    expect(entries["ppt/slides/slide3.xml"]).toBeDefined();
    const slide3 = strFromU8(entries["ppt/slides/slide3.xml"]!);
    expect(slide3).toContain("Product Roadmap");
    expect(slide3).toContain("Launch");
    expect(slide3).toContain("Measure");
    expect(slide3).toContain("Improve");
    expect(strFromU8(entries["ppt/presentation.xml"]).match(/<p:sldId\b/g)?.length).toBe(3);
  });

  it("adds text to an existing PPTX slide", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Add bullet Forecast risk to slide 1 and return the deck",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    expect(strFromU8(entries["ppt/slides/slide1.xml"]!)).toContain("Forecast risk");
  });

  it("polishes PPTX text for professionalize requests instead of falling back to a report", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "messy-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64WithSlideText("really messy   pricing overview"),
      extractedText: "Slide 1:\n- really messy pricing overview",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Make this deck more professional and return the PowerPoint",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const slide1 = strFromU8(entries["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Messy Pricing Overview");
    expect(slide1).not.toContain("really messy");
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

  it("polishes DOCX text for professionalize requests while returning the original package type", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml":
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>basically this is very very important  .</w:t></w:r></w:p></w:body></w:document>',
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "messy-report.docx",
      rawFileType: "docx",
      base64,
      extractedText: "basically this is very very important.",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Make this document more professional and send it back",
      format: "docx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const docXml = strFromU8(entries["word/document.xml"]!);
    expect(docXml).toContain("This Is Very Important.");
    expect(docXml).not.toContain("basically");
    expect(result?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
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

  it("adds new DOCX sections from natural insert wording", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml":
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Executive summary</w:t></w:r></w:p></w:body></w:document>',
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "quarterly-report.docx",
      rawFileType: "docx",
      base64,
      extractedText: "Executive summary",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message:
        "Add a section called Risk Notes with content Track renewal risk and return the document",
      format: "docx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const entries = unzipBase64(result!.fileData);
    const docXml = strFromU8(entries["word/document.xml"]!);
    expect(docXml).toContain("Executive summary");
    expect(docXml).toContain("Risk Notes");
    expect(docXml).toContain("Track renewal risk");
    expect(docXml).not.toContain("called Risk Notes");
    expect(docXml).not.toContain("content Track renewal risk");
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

  it("cleans and formats uploaded XLSX workbooks for natural cleanup requests", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pipeline");
    sheet.addRow([" Region ", " Revenue "]);
    sheet.addRow([" North  ", "120"]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const ref = storeRawOffice({
      sessionId,
      filename: "pipeline.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Clean this spreadsheet and make it professional",
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
    expect(edited?.getCell("A2").value).toBe("North");
    expect(edited?.views[0]?.state).toBe("frozen");
    expect(edited?.autoFilter).toBeTruthy();
    expect(edited?.getCell("A1").font?.bold).toBe(true);
  });

  it("adds workbook sheets, columns, and rows from natural edit requests", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pipeline");
    sheet.addRow(["Region", "Revenue"]);
    sheet.addRow(["North", 120]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const ref = storeRawOffice({
      sessionId,
      filename: "pipeline.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message:
        "Add a sheet named Summary, add a Status column, add row West, 150, Open, and return the Excel file",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(
      Buffer.from(result!.fileData, "base64") as unknown as Parameters<typeof out.xlsx.load>[0],
    );
    expect(out.getWorksheet("Summary")).toBeDefined();
    expect(out.getWorksheet("Summary")?.getCell("C1").value).toBeNull();
    const edited = out.getWorksheet("Pipeline");
    expect(edited?.getCell("C1").value).toBe("Status");
    expect(edited?.getCell("A3").value).toBe("West");
  });

  it("renames, sorts, and deduplicates uploaded XLSX workbooks", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pipeline");
    sheet.addRow(["Region", "Revenue"]);
    sheet.addRow(["West", 150]);
    sheet.addRow(["North", 120]);
    sheet.addRow(["West", 150]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const ref = storeRawOffice({
      sessionId,
      filename: "pipeline.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message:
        "Rename the sheet to Clean Pipeline, sort by Region, dedupe duplicate rows, and return the Excel file",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(
      Buffer.from(result!.fileData, "base64") as unknown as Parameters<typeof out.xlsx.load>[0],
    );
    const edited = out.getWorksheet("Clean Pipeline");
    expect(edited).toBeDefined();
    expect(edited?.actualRowCount).toBe(3);
    expect(edited?.getCell("A2").value).toBe("North");
    expect(edited?.getCell("A3").value).toBe("West");
  });

  it("returns the ORIGINAL bytes untouched for send-it-back requests", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = makePptxBase64();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64,
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Can you send me back the PowerPoint file?",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(result?.fileData).toBe(base64);
    expect(result?.fileName).toBe("board-review.pptx");
    expect(result?.reply).toContain("no changes made");
    // The passthrough must never consult the AI planner.
    expect(aiPlanner.calls.length).toBe(0);
  });

  it("returns the original unchanged for 'same file, no changes' requests", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = makePptxBase64();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64,
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Please give me the document back exactly as it is, without any changes",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(result?.fileData).toBe(base64);
    expect(aiPlanner.calls.length).toBe(0);
  });

  it("marks real edits with editedFileRef and leaves passthroughs unmarked", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    // Real in-place edit → the marker lets routes repoint the durable mirror
    // at the edited asset (post-restart revisions must compound).
    const edited = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace the text "Old Pricing" with "New Pricing" in the deck',
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });
    expect(edited).not.toBeNull();
    expect(edited?.editedFileRef).toBe(ref);

    // Unchanged passthrough → no marker (the original asset is still correct).
    const passthrough = await tryApplyLayoutPreservingFileEdit({
      message: "Please give me the document back exactly as it is, without any changes",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });
    expect(passthrough).not.toBeNull();
    expect(passthrough?.editedFileRef).toBeUndefined();
  });

  it("applies AI-planned in-place ops when regex engines cannot parse the phrasing", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [{ find: "Old Pricing", replace: "Refreshed Pricing" }],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Reword the pricing line in the deck so it sounds current",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    expect(aiPlanner.calls.length).toBe(1);
    const entries = unzipBase64(result!.fileData);
    const slide1 = strFromU8(entries["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Refreshed Pricing");
    expect(slide1).not.toContain("Old Pricing");
    // Original package preserved: slide 2 still present.
    expect(entries["ppt/slides/slide2.xml"]).toBeDefined();
    expect(result?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("returns the file unchanged with an honest note when in-place ops cannot be located", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = makePptxBase64();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64,
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [{ find: "Text that does not exist anywhere", replace: "irrelevant" }],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Reword the executive summary paragraph in the deck",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    // No silent regeneration: the ORIGINAL bytes come back with an honest note.
    expect(result).not.toBeNull();
    expect(result?.fileData).toBe(base64);
    expect(result?.fileName).toBe("pricing-deck.pptx");
    expect(result?.reply).toContain("returning it unchanged");
  });

  it("returns the file unchanged with a rebuild escape hatch when the AI planner votes regenerate", async () => {
    const sessionId = crypto.randomUUID();
    const base64 = makePptxBase64();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64,
      extractedText: "Slide 1:\n- Old Pricing",
    });
    aiPlanner.plan = { mode: "regenerate", operations: [] };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Reword the whole deck into a completely different story arc",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    // No silent regeneration even on a regenerate vote: original bytes come
    // back with an honest note offering an explicit rebuild escape hatch.
    expect(result).not.toBeNull();
    expect(aiPlanner.calls.length).toBe(1);
    expect(result?.fileData).toBe(base64);
    expect(result?.reply).toContain('say "rebuild it from scratch"');
  });

  it("still allows full regeneration when the user explicitly asks to rebuild from scratch", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing",
    });
    aiPlanner.plan = { mode: "regenerate", operations: [] };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Rebuild it from scratch with a completely different story arc",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    // Explicit new-document phrasing opts out of the in-place guard entirely.
    expect(result).toBeNull();
  });

  it("applies a paragraph-level edit when the target text is fragmented across pptx runs", async () => {
    const sessionId = crypto.randomUUID();
    const slideXml = [
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>',
      '<a:p><a:r><a:rPr b="1"/><a:t>Metal</a:t></a:r><a:r><a:t>lic shaving root cause</a:t></a:r></a:p>',
      "</p:spTree></p:cSld></p:sld>",
    ].join("");
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
      "ppt/slides/slide1.xml": slideXml,
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "root-cause.pptx",
      rawFileType: "pptx",
      base64,
      extractedText: "Slide 1: Metallic shaving root cause",
    });
    // "Metallic shaving root cause" never appears inside a single <a:t> node,
    // so the node-level pass cannot find it — only the paragraph-level pass can.
    aiPlanner.plan = {
      mode: "edit",
      operations: [
        { find: "Metallic shaving root cause", replace: "Five whys: metallic shavings" },
      ],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Revise slide 1 so it covers the five whys for the metallic shavings",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const slide1 = strFromU8(unzipBase64(result!.fileData)["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Five whys: metallic shavings");
    expect(slide1).not.toContain("lic shaving root cause");
    // Run formatting properties survive the rewrite.
    expect(slide1).toContain('<a:rPr b="1"/>');
  });

  it("expands newline replacements into cloned pptx paragraphs (multi-bullet rewrite)", async () => {
    const sessionId = crypto.randomUUID();
    const slideXml = [
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>',
      "<a:p><a:pPr/><a:r><a:t>Bolt torque failure</a:t></a:r></a:p>",
      "</p:spTree></p:cSld></p:sld>",
    ].join("");
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
      "ppt/slides/slide1.xml": slideXml,
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "whys.pptx",
      rawFileType: "pptx",
      base64,
      extractedText: "Slide 1: Bolt torque failure",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [
        {
          find: "Bolt torque failure",
          replace: "Why 1: shavings in housing\nWhy 2: filter bypass\nWhy 3: worn tooling",
        },
      ],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Revise slide 1 to list the whys instead of the bolt issue",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const slide1 = strFromU8(unzipBase64(result!.fileData)["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Why 1: shavings in housing");
    expect(slide1).toContain("Why 2: filter bypass");
    expect(slide1).toContain("Why 3: worn tooling");
    expect(slide1).not.toContain("Bolt torque failure");
    // Each line became its own paragraph, preserving paragraph properties.
    expect(slide1.match(/<a:p>/g)?.length).toBe(3);
    expect(slide1.match(/<a:pPr\/>/g)?.length).toBe(3);
  });

  it("rewrites fragmented docx runs and turns newlines into <w:br/>", async () => {
    const sessionId = crypto.randomUUID();
    const docXml = [
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Quarterly sum</w:t></w:r><w:r><w:t>mary intro</w:t></w:r></w:p>",
      "</w:body></w:document>",
    ].join("");
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml": docXml,
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "report.docx",
      rawFileType: "docx",
      base64,
      extractedText: "Quarterly summary intro",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [{ find: "Quarterly summary intro", replace: "Line one\nLine two" }],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Revise the intro paragraph of the report",
      format: "docx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result).not.toBeNull();
    const doc = strFromU8(unzipBase64(result!.fileData)["word/document.xml"]!);
    expect(doc).toContain("Line one");
    expect(doc).toContain("Line two");
    expect(doc).toContain("<w:br/>");
    expect(doc).not.toContain("mary intro");
    // Formatting of the first run survives.
    expect(doc).toContain("<w:b/>");
  });

  it("never rewrites docx paragraphs containing field codes", async () => {
    const sessionId = crypto.randomUUID();
    const docXml = [
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>Page marker text</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      "</w:body></w:document>",
    ].join("");
    const base64 = zipBase64({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml": docXml,
    });
    const ref = storeRawOffice({
      sessionId,
      filename: "field.docx",
      rawFileType: "docx",
      base64,
      extractedText: "Page marker text",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [{ find: "Page marker text", replace: "Broken field" }],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Revise the page marker wording",
      format: "docx",
      documentRefs: [ref],
      sessionId,
    });

    // Paragraph is skipped (field codes would corrupt), so the file comes back
    // unchanged with the honest note instead of a mangled document.
    expect(result).not.toBeNull();
    expect(result?.fileData).toBe(base64);
    expect(result?.reply).toContain("returning it unchanged");
  });

  it("compounds follow-up edits on the edited file, not the original upload", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const first = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace "Old Pricing" with "Interim Pricing"',
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });
    expect(first).not.toBeNull();
    expect(strFromU8(unzipBase64(first!.fileData)["ppt/slides/slide1.xml"]!)).toContain(
      "Interim Pricing",
    );

    // Second edit targets text that only exists AFTER the first edit. It can
    // only succeed if the first edit was written back to the session store.
    const second = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace "Interim Pricing" with "Final Pricing"',
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });
    expect(second).not.toBeNull();
    const slide1 = strFromU8(unzipBase64(second!.fileData)["ppt/slides/slide1.xml"]!);
    expect(slide1).toContain("Final Pricing");
    expect(slide1).not.toContain("Interim Pricing");
    expect(slide1).not.toContain("Old Pricing");
  });
});

describe("editQuality card metadata", () => {
  it("stamps original_edited with a change list on regex-engine edits", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: 'Replace the text "Old Pricing" with "New Pricing" in the deck',
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result?.editQuality).toBeDefined();
    expect(result?.editQuality?.editMode).toBe("original_edited");
    expect(result?.editQuality?.changes?.length).toBeGreaterThan(0);
    expect(result?.editQuality?.originalFileName).toBe("board-review.pptx");
    expect(result?.editQuality?.outputFileName).toBe(result?.fileName);
    expect(result?.editQuality?.sourceFileType).toBe("pptx");
    expect(result?.editQuality?.preservedLayout).toBe(true);
    expect(result?.editQuality?.canRedesign).toBe(true);
    expect(result?.editQuality?.warning).toBeUndefined();
  });

  it("stamps unchanged on send-it-back passthroughs", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "board-review.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Can you send me back the PowerPoint file?",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result?.editQuality?.editMode).toBe("unchanged");
    expect(result?.editQuality?.changes).toEqual([]);
    expect(result?.editQuality?.warning).toBeUndefined();
    expect(result?.editQuality?.preservedLayout).toBe(true);
  });

  it("describes each applied AI-planned op as a Replaced change line", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [{ find: "Old Pricing", replace: "Refreshed Pricing" }],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Reword the pricing line in the deck so it sounds current",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result?.editQuality?.editMode).toBe("original_edited");
    expect(result?.editQuality?.changes).toEqual(['Replaced: "Old Pricing" → "Refreshed Pricing"']);
  });

  it("stamps failed_safe with a warning when in-place ops cannot be located", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing\nSlide 2:\n- Delete Me",
    });
    aiPlanner.plan = {
      mode: "edit",
      operations: [{ find: "Text that does not exist anywhere", replace: "irrelevant" }],
    };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Reword the executive summary paragraph in the deck",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result?.editQuality?.editMode).toBe("failed_safe");
    expect(result?.editQuality?.changes).toEqual([]);
    expect(result?.editQuality?.warning).toContain("Couldn't locate");
    // Original returned untouched, so layout is intact by definition.
    expect(result?.editQuality?.preservedLayout).toBe(true);
  });

  it("stamps failed_safe with a restructuring warning on a regenerate vote", async () => {
    const sessionId = crypto.randomUUID();
    const ref = storeRawOffice({
      sessionId,
      filename: "pricing-deck.pptx",
      rawFileType: "pptx",
      base64: makePptxBase64(),
      extractedText: "Slide 1:\n- Old Pricing",
    });
    aiPlanner.plan = { mode: "regenerate", operations: [] };

    const result = await tryApplyLayoutPreservingFileEdit({
      message: "Reword the whole deck into a completely different story arc",
      format: "pptx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result?.editQuality?.editMode).toBe("failed_safe");
    expect(result?.editQuality?.warning).toContain("restructuring");
  });

  it("lists each XLSX action as its own change line", async () => {
    const sessionId = crypto.randomUUID();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pipeline");
    sheet.addRow(["Region", "Revenue"]);
    sheet.addRow(["North", 120]);
    const raw = Buffer.from(await workbook.xlsx.writeBuffer());
    const ref = storeRawOffice({
      sessionId,
      filename: "pipeline.xlsx",
      rawFileType: "xlsx",
      base64: raw.toString("base64"),
    });

    const result = await tryApplyLayoutPreservingFileEdit({
      message:
        "Add a sheet named Summary, add a Status column, add row West, 150, Open, and return the Excel file",
      format: "xlsx",
      documentRefs: [ref],
      sessionId,
    });

    expect(result?.editQuality?.editMode).toBe("original_edited");
    expect(result?.editQuality?.sourceFileType).toBe("xlsx");
    expect(result?.editQuality?.changes?.length).toBeGreaterThanOrEqual(2);
    expect(
      result?.editQuality?.changes?.some((change) => change.includes('worksheet "Summary"')),
    ).toBe(true);
  });
});
