import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { PassThrough } from "stream";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { scanUserInput } from "../../lib/public-ai/prompt";

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(40000),
});

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  messages: z.array(messageItemSchema).max(20).default([]),
  format: z.enum(["csv", "xlsx", "docx", "pdf"]),
  language: z.string().max(20).optional(),
});

// ── Tabular data schema returned by the AI for csv / xlsx ──────────────────
interface TabularData {
  title: string;
  sheetName?: string;
  headers: string[];
  rows: string[][];
}

// ── Document data schema returned by the AI for docx / pdf ─────────────────
interface DocumentSection {
  heading?: string;
  content: string;
}
interface DocumentData {
  title: string;
  sections: DocumentSection[];
}

// ── System prompts ───────────────────────────────────────────────────────────
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
    `  "headers": ["Column A", "Column B", ...],\n` +
    `  "rows": [["value1", "value2", ...], ...]\n` +
    `}\n` +
    `Generate realistic, complete data with at least 5 rows. Use strings for all cell values.${langNote}`
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

// ── Converters ───────────────────────────────────────────────────────────────

async function buildCsv(data: TabularData): Promise<Buffer> {
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

async function buildXlsx(data: TabularData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MustaFlow Ora";
  wb.created = new Date();
  const ws = wb.addWorksheet(data.sheetName ?? "Sheet1");

  // Header row — bold
  const headerRow = ws.addRow(data.headers);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E1B4B" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF6366F1" } },
    };
  });

  // Data rows
  for (const row of data.rows) {
    ws.addRow(row);
  }

  // Auto-fit columns (approximate)
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

async function buildDocx(data: DocumentData): Promise<Buffer> {
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
    // Split on double newlines to create separate paragraphs
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

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

async function buildPdf(data: DocumentData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: "A4" });
    const pass = new PassThrough();
    const chunks: Buffer[] = [];

    doc.pipe(pass);
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    pass.on("finish", () => resolve(Buffer.concat(chunks)));
    pass.on("error", reject);

    // Title
    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor("#1e1b4b")
      .text(data.title, { align: "left" })
      .moveDown(0.8);

    // Divider line
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

// ── Filename helpers ─────────────────────────────────────────────────────────
function safeFileName(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "file"}.${ext}`;
}

function mimeForFormat(format: string): string {
  switch (format) {
    case "csv":
      return "text/csv";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function extForFormat(format: string): string {
  return format;
}

// ── Route ────────────────────────────────────────────────────────────────────
router.post("/public-ai/generate-file", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { message, messages, format, language } = parsed.data;

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }

  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }

  if (session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error: "You have reached the message limit for this session.",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  if (!scanUserInput(message)) {
    res.status(400).json({ error: "Message contains patterns that cannot be processed." });
    return;
  }

  const isTabular = format === "csv" || format === "xlsx";
  const systemPrompt = isTabular
    ? buildTabularSystemPrompt(format as "csv" | "xlsx", language)
    : buildDocumentSystemPrompt(format as "docx" | "pdf", language);

  const historyMessages = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...historyMessages,
    { role: "user" as const, content: message },
  ];

  let fileBuffer: Buffer;
  let title = "file";
  let rowCount = 0;
  let sectionCount = 0;

  try {
    const { createChatCompletion } = await import("../../lib/ai-providers");
    const result = await createChatCompletion({
      provider: "openai",
      model: process.env.ORA_PREMIUM_MODEL ?? "gpt-5.4",
      messages: callMessages,
      response_format: { type: "json_object" },
      max_completion_tokens: 2000,
    });

    const raw = result.choices[0]?.message?.content?.trim() ?? "{}";
    const aiData = JSON.parse(raw) as Record<string, unknown>;

    if (isTabular) {
      const data: TabularData = {
        title: String(aiData.title ?? "Data"),
        sheetName: String(aiData.sheetName ?? "Sheet1"),
        headers: Array.isArray(aiData.headers)
          ? (aiData.headers as string[]).map(String)
          : ["Column A"],
        rows: Array.isArray(aiData.rows)
          ? (aiData.rows as unknown[][]).map((r) =>
              Array.isArray(r) ? r.map(String) : [String(r)],
            )
          : [],
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
  } catch (err) {
    logger.error({ component: "ora-generate-file", format, err }, "File generation failed");
    res.status(500).json({ error: "Failed to generate file. Please try again." });
    return;
  }

  const { token, payload } = incrementMessageCount(session);
  setSessionCookie(res, token);

  const fileName = safeFileName(title, extForFormat(format));
  const mimeType = mimeForFormat(format);
  const fileData = fileBuffer.toString("base64");

  const formatLabel = format.toUpperCase();
  const summary = isTabular
    ? `${rowCount} row${rowCount !== 1 ? "s" : ""}`
    : `${sectionCount} section${sectionCount !== 1 ? "s" : ""}`;

  const reply = `Here's your ${formatLabel} file — "${title}" (${summary}). Click Download below to save it.`;

  logger.info(
    { component: "ora-generate-file", format, fileName, bytes: fileBuffer.length },
    "File generated",
  );

  res.json({
    reply,
    fileName,
    fileData,
    mimeType,
    msgCount: payload.msgCount,
    msgLimit: MSG_LIMIT_VALUE,
  });
});

export default router;
