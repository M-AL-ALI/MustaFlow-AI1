/**
 * Shared file building utilities used by both the generate-file route and
 * the chat route (when a file request is auto-detected).
 */
import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { PassThrough } from "stream";
import { createChatCompletion } from "../ai-providers";
import type { FileFormat } from "./prompt";

export type { FileFormat };

export interface TabularData {
  title: string;
  sheetName?: string;
  headers: string[];
  rows: string[][];
}

export interface DocumentSection {
  heading?: string;
  content: string;
}

export interface DocumentData {
  title: string;
  sections: DocumentSection[];
}

export interface GeneratedFileResult {
  fileName: string;
  fileData: string;
  mimeType: string;
  reply: string;
  rowCount?: number;
  sectionCount?: number;
}

function buildTabularSystemPrompt(format: "csv" | "xlsx", language?: string): string {
  const langNote =
    language && language !== "auto"
      ? `\nRespond in ${language}. All generated text (headers, data values) must be in ${language}.`
      : "";
  return (
    `You are a data generation assistant. The user wants to generate a ${format.toUpperCase()} file.\n` +
    `Return ONLY valid JSON with no prose, no markdown, no code fences — just the raw JSON object.\n` +
    `Use this exact shape:\n` +
    `{\n` +
    `  "title": "Descriptive title for the file",\n` +
    `  "sheetName": "Sheet1",\n` +
    `  "headers": ["Column A", "Column B", "Column C"],\n` +
    `  "rows": [\n` +
    `    ["row1_value_A", "row1_value_B", "row1_value_C"],\n` +
    `    ["row2_value_A", "row2_value_B", "row2_value_C"]\n` +
    `  ]\n` +
    `}\n\n` +
    `CRITICAL RULES — you must follow all of these:\n` +
    `1. Every row in "rows" MUST have EXACTLY the same number of values as there are items in "headers". No more, no fewer.\n` +
    `2. The order of values in each row must match the order of headers exactly (first value = first column, second value = second column, etc.).\n` +
    `3. Use short, clean header names (1-3 words). No trailing spaces, no newlines inside values.\n` +
    `4. All values must be strings. Numbers should be written as strings (e.g. "42", "1500.00").\n` +
    `5. Generate at least 8 realistic, varied rows. Data should be meaningful and consistent within each column.\n` +
    `6. Do not include any explanation or extra keys — only title, sheetName, headers, rows.${langNote}`
  );
}

function buildDocumentSystemPrompt(format: "docx" | "pdf", language?: string): string {
  const langNote =
    language && language !== "auto"
      ? `\nRespond in ${language}. All generated content must be in ${language}.`
      : "";
  return (
    `You are a document writing assistant. The user wants to generate a ${format.toUpperCase()} file.\n` +
    `Return ONLY valid JSON with no prose, no markdown, no code fences — just the raw JSON object.\n` +
    `Use this exact shape:\n` +
    `{\n` +
    `  "title": "Document Title",\n` +
    `  "sections": [\n` +
    `    { "heading": "Section Heading", "content": "Paragraph text..." },\n` +
    `    { "content": "A paragraph without a heading..." }\n` +
    `  ]\n` +
    `}\n` +
    `Write a complete, professional document. Each section should have substantive content.${langNote}`
  );
}

export async function buildCsv(data: TabularData): Promise<Buffer> {
  const escapeCell = (v: string) => {
    if (v.includes(",") || v.includes('"') || v.includes("\n")) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const lines = [data.headers.map(escapeCell).join(",")];
  for (const row of data.rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

export async function buildXlsx(data: TabularData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MustaFlow Ora";
  wb.created = new Date();
  const ws = wb.addWorksheet(data.sheetName ?? "Sheet1");

  const headerRow = ws.addRow(data.headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E1B4B" },
    };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF6366F1" } },
    };
  });

  for (const row of data.rows) {
    ws.addRow(row);
  }

  ws.columns.forEach((col, i) => {
    const maxLen = Math.max(
      (data.headers[i] ?? "").length,
      ...data.rows.map((r) => (r[i] ?? "").length),
    );
    col.width = Math.min(Math.max(maxLen + 2, 10), 40);
  });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function buildDocx(data: DocumentData): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: data.title, bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 300 },
    }),
  ];

  for (const section of data.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          text: section.heading,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 120 },
        }),
      );
    }
    const paras = section.content.split(/\n{2,}/);
    for (const para of paras) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: para.trim() })],
          spacing: { after: 160 },
        }),
      );
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildPdf(data: DocumentData): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: "A4" });
    const pass = new PassThrough();
    const chunks: Buffer[] = [];

    doc.pipe(pass);
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    pass.on("finish", () => resolve(Buffer.concat(chunks)));
    pass.on("error", reject);

    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor("#1e1b4b")
      .text(data.title, { align: "left" })
      .moveDown(0.8);

    doc
      .moveTo(60, doc.y)
      .lineTo(doc.page.width - 60, doc.y)
      .strokeColor("#6366f1")
      .lineWidth(1.5)
      .stroke()
      .moveDown(0.8);

    for (const section of data.sections) {
      if (section.heading) {
        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .fillColor("#1e1b4b")
          .text(section.heading)
          .moveDown(0.3);
      }
      doc
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#374151")
        .text(section.content, { align: "justify", lineGap: 3 })
        .moveDown(0.6);
    }

    doc.end();
  });
}

function safeFileName(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "file"}.${ext}`;
}

function mimeForFormat(format: FileFormat): string {
  switch (format) {
    case "csv":
      return "text/csv";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf":
      return "application/pdf";
  }
}

/**
 * Calls the AI and builds the file buffer. Returns everything needed to
 * send the file back to the client.
 */
export async function generateFileFromPrompt(
  message: string,
  format: FileFormat,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<GeneratedFileResult> {
  const isTabular = format === "csv" || format === "xlsx";
  const systemPrompt = isTabular
    ? buildTabularSystemPrompt(format as "csv" | "xlsx", language)
    : buildDocumentSystemPrompt(format as "docx" | "pdf", language);

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...history.slice(-10),
    { role: "user" as const, content: message },
  ];

  const result = await createChatCompletion({
    provider: "openai",
    model: process.env.ORA_PREMIUM_MODEL ?? "gpt-5.4",
    messages: callMessages,
    response_format: { type: "json_object" },
    max_completion_tokens: 4000,
  });

  const raw = result.choices[0]?.message?.content?.trim() ?? "{}";
  const aiData = JSON.parse(raw) as Record<string, unknown>;

  let fileBuffer: Buffer;
  let title = "file";
  let rowCount = 0;
  let sectionCount = 0;

  if (isTabular) {
    const rawHeaders = Array.isArray(aiData.headers)
      ? (aiData.headers as string[]).map((h) => String(h).trim()).filter(Boolean)
      : ["Column A"];
    const colCount = rawHeaders.length;

    const rawRows = Array.isArray(aiData.rows) ? (aiData.rows as unknown[]) : [];
    const normalizedRows = rawRows
      .filter((r) => Array.isArray(r) && (r as unknown[]).length > 0)
      .map((r) => {
        const cells = (r as unknown[]).map((v) => String(v ?? "").trim());
        // Pad short rows with empty strings, trim rows that are too long
        while (cells.length < colCount) cells.push("");
        return cells.slice(0, colCount);
      });

    const data: TabularData = {
      title: String(aiData.title ?? "Data"),
      sheetName: String(aiData.sheetName ?? "Sheet1"),
      headers: rawHeaders,
      rows: normalizedRows,
    };
    title = data.title;
    rowCount = data.rows.length;
    fileBuffer = format === "csv" ? await buildCsv(data) : await buildXlsx(data);
  } else {
    const rawSections = Array.isArray(aiData.sections) ? aiData.sections : [];
    const data: DocumentData = {
      title: String(aiData.title ?? "Document"),
      sections: (rawSections as Record<string, unknown>[]).map((s) => ({
        heading: s.heading != null ? String(s.heading) : undefined,
        content: String(s.content ?? ""),
      })),
    };
    title = data.title;
    sectionCount = data.sections.length;
    fileBuffer = format === "docx" ? await buildDocx(data) : await buildPdf(data);
  }

  const formatLabel = format.toUpperCase();
  const summary = isTabular
    ? `${rowCount} row${rowCount !== 1 ? "s" : ""}`
    : `${sectionCount} section${sectionCount !== 1 ? "s" : ""}`;

  return {
    fileName: safeFileName(title, format),
    fileData: fileBuffer.toString("base64"),
    mimeType: mimeForFormat(format),
    reply: `Here's your ${formatLabel} file — "${title}" (${summary}). Click Download below to save it.`,
    rowCount,
    sectionCount,
  };
}
