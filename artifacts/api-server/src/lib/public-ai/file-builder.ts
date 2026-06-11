/**
 * Shared file building utilities used by both the generate-file route and
 * the chat route (when a file request is auto-detected).
 */
import ExcelJS from "exceljs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  PageNumber,
  Footer,
} from "docx";
import { PassThrough } from "stream";
import { createChatCompletion } from "../ai-providers";
import type { FileFormat } from "./prompt";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  openAiModelForOraFile,
  runCandidateChain,
  selectOraFileModelRoute,
  type ModelCandidate,
  type OraPlanTier,
} from "./model-router";
import PptxGenJS from "pptxgenjs";

export type { FileFormat };

/**
 * Thrown when file generation cannot honor the user's request — most importantly
 * when source data was attached but the model returned nothing usable. Routes
 * map this to a client-facing error instead of silently returning an empty file.
 */
export class FileGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileGenerationError";
  }
}

export type ColumnType = "text" | "number" | "currency" | "date" | "percent";

export interface TabularData {
  title: string;
  sheetName?: string;
  headers: string[];
  columnTypes?: ColumnType[];
  rows: string[][];
}

export interface DocumentSection {
  heading?: string;
  content: string;
  bullets?: string[];
}

export interface DocumentData {
  title: string;
  subtitle?: string;
  sections: DocumentSection[];
}

export interface PresentationSlide {
  heading: string;
  bullets: string[];
}

export interface PresentationData {
  title: string;
  subtitle?: string;
  slides: PresentationSlide[];
}

export interface GeneratedFileResult {
  fileName: string;
  fileData: string;
  mimeType: string;
  reply: string;
  rowCount?: number;
  sectionCount?: number;
  slideCount?: number;
}

export type OraFileQualityDepth = "standard" | "polished" | "premium";

export interface OraFileQualityProfile {
  depth: OraFileQualityDepth;
  minSyntheticRows: number;
  minSyntheticSlides: number;
  minSyntheticSections: number;
  maxCompletionTokens: number;
  instruction: string;
}

export function resolveOraFileQualityProfile(input: {
  format: FileFormat;
  planTier: OraPlanTier;
  hasSourceData?: boolean;
}): OraFileQualityProfile {
  const sourceBoost = input.hasSourceData ? 1000 : 0;
  const sourceLine = input.hasSourceData
    ? "Source fidelity check: preserve real uploaded values, keep the user's requested subset/filter exact, and never replace missing source facts with invented filler."
    : "Synthetic content check: make examples realistic, internally consistent, useful, and free of placeholder text.";

  if (input.planTier === "wave") {
    return {
      depth: "premium",
      minSyntheticRows: 24,
      minSyntheticSlides: 10,
      minSyntheticSections: 7,
      maxCompletionTokens: 10000 + sourceBoost,
      instruction:
        `\n\nQUALITY PROFILE: premium.\n` +
        `${sourceLine}\n` +
        `Before returning JSON, internally verify that the structure is complete, polished, deduplicated, and aligned with the requested ${input.format.toUpperCase()} purpose. Prefer executive-ready wording, clear sectioning, and practical details over generic filler.`,
    };
  }

  if (input.planTier === "core") {
    return {
      depth: "polished",
      minSyntheticRows: 16,
      minSyntheticSlides: 7,
      minSyntheticSections: 5,
      maxCompletionTokens: 9000 + sourceBoost,
      instruction:
        `\n\nQUALITY PROFILE: polished.\n` +
        `${sourceLine}\n` +
        `Before returning JSON, internally verify that every required field is present, naming is clean, rows/sections/slides are coherent, and the result is ready to download without manual cleanup.`,
    };
  }

  return {
    depth: "standard",
    minSyntheticRows: 10,
    minSyntheticSlides: 5,
    minSyntheticSections: 4,
    maxCompletionTokens: 8000 + sourceBoost,
    instruction:
      `\n\nQUALITY PROFILE: standard.\n` +
      `${sourceLine}\n` +
      `Before returning JSON, internally verify that required fields are present, no placeholder text remains, and the file is usable as-is.`,
  };
}

// ---------------------------------------------------------------------------
// AI system prompts
// ---------------------------------------------------------------------------

// When the user attached a file, the builder receives its real content. The
// model must transcribe/transform that data faithfully instead of inventing
// plausible-looking rows — fabrication was the #1 reported file-creation bug.
const SOURCE_DATA_DIRECTIVE =
  `\n\nSOURCE DATA PROVIDED:\n` +
  `The user's message includes the actual content of file(s) they uploaded (look for an "[ATTACHED FILES ...]" or "[DATASET ...]" block). You MUST build this file from that real data:\n` +
  `- Extract, organize, and transform the ACTUAL values from the attached content.\n` +
  `- Do NOT invent, fabricate, guess, or pad with placeholder/sample data.\n` +
  `- Preserve every real row/record/value the user asked for; do not drop, summarize away, or truncate data unless explicitly told to.\n` +
  `- If the user asks for a subset (e.g. specific columns, a filter, a total), derive it from the real data only.\n` +
  `- If the attached data is empty or does not contain what the user asked for, return your best structure from what IS present rather than making up values.`;

function buildTabularSystemPrompt(
  format: "csv" | "xlsx",
  language?: string,
  hasSourceData = false,
  quality: OraFileQualityProfile = resolveOraFileQualityProfile({
    format,
    planTier: "free",
    hasSourceData,
  }),
): string {
  const langNote =
    language && language !== "auto"
      ? `\nRespond in ${language}. All generated text (headers, data values) must be in ${language}.`
      : "";
  const rowRule = hasSourceData
    ? `4. Use the real rows from the attached data — include all of them (or exactly the subset requested). Do NOT add invented rows.\n`
    : `4. Generate at least ${quality.minSyntheticRows} realistic, varied, logically sorted rows.\n`;
  return (
    `You are a data generation expert. The user wants a professionally organized ${format.toUpperCase()} file.\n` +
    `Return ONLY valid JSON — no prose, no markdown, no code fences.\n\n` +
    `Required JSON shape:\n` +
    `{\n` +
    `  "title": "Descriptive title",\n` +
    `  "sheetName": "Sheet name (short)",\n` +
    `  "headers": ["Column 1", "Column 2", "Column 3"],\n` +
    `  "columnTypes": ["text", "number", "currency"],\n` +
    `  "rows": [\n` +
    `    ["Alice Johnson", "42", "1500.00"],\n` +
    `    ["Bob Smith",     "37", "2200.50"]\n` +
    `  ]\n` +
    `}\n\n` +
    `columnTypes values: "text" | "number" | "currency" | "date" | "percent"\n` +
    `  - "date" values must be formatted as YYYY-MM-DD\n` +
    `  - "currency" and "number" values must be numeric strings (no symbols)\n` +
    `  - "percent" values must be decimal strings (e.g. "0.85" for 85%)\n\n` +
    `STRICT RULES:\n` +
    `1. EVERY row must have EXACTLY the same number of values as "headers". No exceptions.\n` +
    `2. Values are in the SAME ORDER as headers (index 0 = first column, etc.).\n` +
    `3. Header names: short, clean, title-case (1–3 words). No duplicates.\n` +
    rowRule +
    `5. Data must be internally consistent — e.g. dates in chronological order, ids sequential.\n` +
    `6. Only these keys are allowed: title, sheetName, headers, columnTypes, rows.${langNote}` +
    quality.instruction +
    (hasSourceData ? SOURCE_DATA_DIRECTIVE : "")
  );
}

function buildPresentationSystemPrompt(
  language?: string,
  hasSourceData = false,
  quality: OraFileQualityProfile = resolveOraFileQualityProfile({
    format: "pptx",
    planTier: "free",
    hasSourceData,
  }),
): string {
  const langNote =
    language && language !== "auto"
      ? `\nRespond in ${language}. All generated content must be in ${language}.`
      : "";
  return (
    `You are a professional presentation designer. The user wants a well-structured PowerPoint presentation.\n` +
    `Return ONLY valid JSON -- no prose, no markdown, no code fences.\n\n` +
    `Required JSON shape:\n` +
    `{\n` +
    `  "title": "Presentation Title",\n` +
    `  "subtitle": "Optional subtitle or tagline",\n` +
    `  "slides": [\n` +
    `    {\n` +
    `      "heading": "Slide Heading",\n` +
    `      "bullets": ["First key point", "Second key point", "Third key point"]\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `RULES:\n` +
    (hasSourceData
      ? `1. Build the slides from the actual content of the attached file(s); do not invent facts or figures.\n`
      : `1. Include at least ${quality.minSyntheticSlides} slides with meaningful, distinct headings.\n`) +
    `2. Each slide must have 3-6 concise bullet points -- short, professional, no leading dashes.\n` +
    `3. Bullet text must be plain -- no markdown, no asterisks, no hyphens at the start.\n` +
    `4. Headings must be short (3-7 words max) and clearly titled.\n` +
    `5. The subtitle is optional -- use it for a tagline, date, or author.\n` +
    `6. Match the presentation topic and purpose to exactly what the user asked for.\n` +
    `7. Only these keys are allowed: title, subtitle, slides (each with heading and bullets).${langNote}` +
    quality.instruction +
    (hasSourceData ? SOURCE_DATA_DIRECTIVE : "")
  );
}

function buildDocumentSystemPrompt(
  format: "docx" | "pdf",
  language?: string,
  hasSourceData = false,
  quality: OraFileQualityProfile = resolveOraFileQualityProfile({
    format,
    planTier: "free",
    hasSourceData,
  }),
): string {
  const langNote =
    language && language !== "auto"
      ? `\nRespond in ${language}. All generated content must be in ${language}.`
      : "";
  return (
    `You are a professional document writer. The user wants a well-structured ${format.toUpperCase()} document.\n` +
    `Return ONLY valid JSON — no prose, no markdown, no code fences.\n\n` +
    `Required JSON shape:\n` +
    `{\n` +
    `  "title": "Document Title",\n` +
    `  "subtitle": "Optional subtitle or date",\n` +
    `  "sections": [\n` +
    `    {\n` +
    `      "heading": "Section Heading",\n` +
    `      "content": "One or more paragraphs of text. Use \\n\\n between paragraphs.",\n` +
    `      "bullets": ["Key point one", "Key point two", "Key point three"]\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `RULES:\n` +
    (hasSourceData
      ? `1. Build the document from the actual content of the attached file(s); summarize/organize the real text, do not invent facts.\n`
      : `1. Write substantive, professional content — not placeholder text.\n`) +
    (hasSourceData
      ? `2. Use as many sections as the source content needs.\n`
      : `2. Include at least ${quality.minSyntheticSections} sections with meaningful headings.\n`) +
    `3. Each section needs either "content", "bullets", or both.\n` +
    `4. "bullets" is an array of concise bullet points (no leading dashes — just the text).\n` +
    `5. Match the document type and purpose to what the user asked for exactly.\n` +
    `6. The subtitle field is optional — use it for date, version, author, or a tagline.\n` +
    `7. Only these keys are allowed: title, subtitle, sections (with heading, content, bullets).${langNote}` +
    quality.instruction +
    (hasSourceData ? SOURCE_DATA_DIRECTIVE : "")
  );
}

// ---------------------------------------------------------------------------
// PPTX builder
// ---------------------------------------------------------------------------

const PPTX_COLORS = {
  titleBg: "0F172A",
  accent: "2563EB",
  heading: "1E3A5F",
  body: "1E293B",
  footer: "94A3B8",
  white: "FFFFFF",
  lightBlue: "7DD3FC",
} as const;

export async function buildPptx(data: PresentationData): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  const slides = Array.isArray(data.slides) ? data.slides : [];

  // Title slide (dark background)
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: PPTX_COLORS.titleBg };

  titleSlide.addText(data.title ?? "Presentation", {
    x: 0.8,
    y: 2.0,
    w: 11.73,
    h: 1.8,
    fontSize: 40,
    bold: true,
    color: PPTX_COLORS.white,
    align: "center",
  });

  if (data.subtitle) {
    titleSlide.addText(data.subtitle, {
      x: 0.8,
      y: 3.9,
      w: 11.73,
      h: 0.7,
      fontSize: 18,
      color: PPTX_COLORS.lightBlue,
      align: "center",
    });
  }

  titleSlide.addText(`Generated by Ora AI - MustaFlow`, {
    x: 0.8,
    y: 4.75,
    w: 11.73,
    h: 0.4,
    fontSize: 12,
    color: PPTX_COLORS.footer,
    align: "center",
  });

  const addFooter = (slide: ReturnType<typeof pptx.addSlide>) => {
    slide.addText(`Confidential - Generated by Ora AI - MustaFlow`, {
      x: 0.3,
      y: 7.15,
      w: 12.73,
      h: 0.35,
      fontSize: 9,
      color: PPTX_COLORS.footer,
      align: "right",
    });
  };

  // Content slides
  for (const slide of slides) {
    const heading = String(slide?.heading ?? "").trim() || "Slide";
    const bullets = Array.isArray(slide?.bullets)
      ? slide.bullets
          .map((b) =>
            String(b ?? "")
              .replace(/^[-*•]\s+/, "")
              .trim(),
          )
          .filter(Boolean)
      : [];

    const s = pptx.addSlide();

    // Heading text
    s.addText(heading, {
      x: 0.5,
      y: 0.25,
      w: 12.33,
      h: 0.8,
      fontSize: 26,
      bold: true,
      color: PPTX_COLORS.heading,
    });

    // Thin accent underline beneath heading
    s.addText(" ", {
      x: 0.5,
      y: 1.1,
      w: 12.33,
      h: 0.06,
      fill: { color: PPTX_COLORS.accent },
      fontSize: 1,
      color: PPTX_COLORS.accent,
    });

    if (bullets.length > 0) {
      const textItems = bullets.map((b, i) => ({
        text: `\u2022  ${b}`,
        options: { breakLine: true, paraSpaceBefore: i === 0 ? 0 : 10 },
      }));

      s.addText(textItems, {
        x: 0.5,
        y: 1.25,
        w: 12.33,
        h: 5.65,
        fontSize: 15,
        color: PPTX_COLORS.body,
        valign: "top",
      });
    }

    addFooter(s);
  }

  const buf = await pptx.write({ outputType: "nodebuffer" });
  return buf as Buffer;
}

// ---------------------------------------------------------------------------
// CSV builder
// ---------------------------------------------------------------------------

export async function buildCsv(data: TabularData): Promise<Buffer> {
  const escapeCell = (v: string) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  // UTF-8 BOM so Excel on Windows opens without garbled characters
  const BOM = "\uFEFF";
  const lines = [data.headers.map(escapeCell).join(",")];
  for (const row of data.rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  return Buffer.from(BOM + lines.join("\r\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// XLSX builder
// ---------------------------------------------------------------------------

function parseCellValue(raw: string, type: ColumnType | undefined): string | number | Date {
  if (!type || type === "text") return raw;
  if (type === "number" || type === "currency" || type === "percent") {
    // eslint-disable-next-line no-useless-escape
    const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? raw : n;
  }
  if (type === "date") {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? raw : d;
  }
  return raw;
}

export async function buildXlsx(data: TabularData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MustaFlow Ora";
  wb.created = new Date();
  const ws = wb.addWorksheet(data.sheetName ?? "Sheet1");

  const HEADER_BG = "FF1E1B4B";
  const HEADER_FG = "FFFFFFFF";
  const ACCENT = "FF6366F1";
  const ROW_ODD = "FFF5F4FF";
  const ROW_EVEN = "FFFFFFFF";
  const BORDER_COLOR = "FFD1D5DB";

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: BORDER_COLOR } },
    left: { style: "thin", color: { argb: BORDER_COLOR } },
    bottom: { style: "thin", color: { argb: BORDER_COLOR } },
    right: { style: "thin", color: { argb: BORDER_COLOR } },
  };

  // Header row
  const headerRow = ws.addRow(data.headers);
  headerRow.height = 22;
  headerRow.eachCell((cell, colIdx) => {
    cell.font = { bold: true, color: { argb: HEADER_FG }, size: 11, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.border = {
      top: { style: "medium", color: { argb: ACCENT } },
      left: { style: "thin", color: { argb: HEADER_BG } },
      bottom: { style: "medium", color: { argb: ACCENT } },
      right: { style: "thin", color: { argb: HEADER_BG } },
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
    const type = data.columnTypes?.[colIdx - 1];
    if (type === "number" || type === "currency" || type === "percent") {
      cell.alignment = { vertical: "middle", horizontal: "right" };
    }
  });

  // Data rows
  data.rows.forEach((row, rowIdx) => {
    const isOdd = rowIdx % 2 === 0;
    const excelRow = ws.addRow(
      row.map((v, colIdx) => parseCellValue(v, data.columnTypes?.[colIdx])),
    );
    excelRow.height = 18;
    excelRow.eachCell((cell, colIdx) => {
      const type = data.columnTypes?.[colIdx - 1];
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: isOdd ? ROW_ODD : ROW_EVEN },
      };
      cell.border = thinBorder;
      cell.font = { name: "Calibri", size: 10 };
      cell.alignment = { vertical: "middle", horizontal: "left", wrapText: false };

      // Type-specific formatting
      if (type === "currency") {
        cell.numFmt = '"$"#,##0.00';
        cell.alignment = { vertical: "middle", horizontal: "right" };
      } else if (type === "number") {
        cell.numFmt = "#,##0.##";
        cell.alignment = { vertical: "middle", horizontal: "right" };
      } else if (type === "percent") {
        cell.numFmt = "0.00%";
        cell.alignment = { vertical: "middle", horizontal: "right" };
      } else if (type === "date" && cell.value instanceof Date) {
        cell.numFmt = "YYYY-MM-DD";
        cell.alignment = { vertical: "middle", horizontal: "center" };
      }
    });
  });

  // Column widths — fit content
  ws.columns.forEach((col, i) => {
    const headerLen = (data.headers[i] ?? "").length;
    const maxDataLen = data.rows.reduce((acc, r) => Math.max(acc, (r[i] ?? "").length), 0);
    col.width = Math.min(Math.max(headerLen, maxDataLen) + 4, 45);
  });

  // Freeze header row + enable auto-filter
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 0, topLeftCell: "A2" }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: data.headers.length },
  };

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// DOCX builder
// ---------------------------------------------------------------------------

function parseBullets(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s+/, "").trim())
    .filter(Boolean);
}

export async function buildDocx(data: DocumentData): Promise<Buffer> {
  const ACCENT = "6366F1";
  const DARK = "1E1B4B";
  const GRAY = "6B7280";

  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: data.title, bold: true, size: 48, color: DARK, font: "Calibri" }),
      ],
      spacing: { after: data.subtitle ? 80 : 240 },
    }),
  );

  // Subtitle
  if (data.subtitle) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: data.subtitle, size: 22, color: GRAY, font: "Calibri" })],
        spacing: { after: 240 },
      }),
    );
  }

  // Horizontal rule (1pt border paragraph)
  children.push(
    new Paragraph({
      children: [],
      border: { bottom: { color: ACCENT, space: 1, style: BorderStyle.SINGLE, size: 12 } },
      spacing: { after: 320 },
    }),
  );

  for (const section of data.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: section.heading,
              bold: true,
              size: 28,
              color: DARK,
              font: "Calibri",
            }),
          ],
          spacing: { before: 400, after: 120 },
          border: { left: { color: ACCENT, space: 8, style: BorderStyle.SINGLE, size: 20 } },
          indent: { left: convertInchesToTwip(0.15) },
        }),
      );
    }

    // Content paragraphs
    if (section.content) {
      const paras = section.content.split(/\n{2,}/).filter(Boolean);
      for (const para of paras) {
        const trimmed = para.trim();
        // Detect inline bullet block (lines starting with - or •)
        const lines = trimmed.split("\n");
        const allBullets = lines.every((l) => /^[-•*]\s/.test(l.trim()));
        if (allBullets) {
          for (const line of parseBullets(trimmed)) {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: line, size: 22, font: "Calibri" })],
                bullet: { level: 0 },
                spacing: { after: 80 },
              }),
            );
          }
        } else {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: trimmed, size: 22, color: "374151", font: "Calibri" }),
              ],
              alignment: AlignmentType.JUSTIFIED,
              spacing: { after: 180, line: 300 },
            }),
          );
        }
      }
    }

    // Explicit bullets array
    if (section.bullets && section.bullets.length > 0) {
      for (const bullet of section.bullets) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: bullet.trim(), size: 22, font: "Calibri" })],
            bullet: { level: 0 },
            spacing: { after: 80 },
          }),
        );
      }
      children.push(new Paragraph({ children: [], spacing: { after: 100 } }));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1.2),
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GRAY }),
                  new TextRun({ text: " / ", size: 18, color: GRAY }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: GRAY }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// PDF builder
// ---------------------------------------------------------------------------

export async function buildPdf(data: DocumentData): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;

  return new Promise((resolve, reject) => {
    const MARGIN = 60;
    // bufferPages:true lets us stamp page numbers after all content is written
    // via switchToPage(), avoiding the recursive pageAdded→text→addPage loop.
    const doc = new PDFDocument({
      margin: MARGIN,
      size: "A4",
      autoFirstPage: true,
      bufferPages: true,
    });
    const pass = new PassThrough();
    const chunks: Buffer[] = [];

    doc.pipe(pass);
    pass.on("data", (chunk: Buffer) => chunks.push(chunk));
    pass.on("finish", () => resolve(Buffer.concat(chunks)));
    pass.on("error", reject);

    const PAGE_W = doc.page.width;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    // Title block
    doc
      .font("Helvetica-Bold")
      .fontSize(22)
      .fillColor("#1E1B4B")
      .text(data.title, MARGIN, MARGIN, { width: CONTENT_W });

    if (data.subtitle) {
      doc
        .moveDown(0.3)
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#6B7280")
        .text(data.subtitle, { width: CONTENT_W });
    }

    // Accent rule under title
    doc.moveDown(0.6);
    const ruleY = doc.y;
    doc
      .moveTo(MARGIN, ruleY)
      .lineTo(PAGE_W - MARGIN, ruleY)
      .strokeColor("#6366F1")
      .lineWidth(2)
      .stroke();
    doc.moveDown(1.2);

    // Sections
    for (const section of data.sections) {
      // Check space — add page if less than 80pt remaining
      if (doc.y > doc.page.height - MARGIN - 80) {
        doc.addPage();
        doc.y = MARGIN + 20;
      }

      if (section.heading) {
        const headingY = doc.y;
        // Left accent bar
        doc.save().rect(MARGIN, headingY, 3, 16).fillColor("#6366F1").fill().restore();

        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .fillColor("#1E1B4B")
          .text(section.heading, MARGIN + 10, headingY, { width: CONTENT_W - 10 });
        doc.moveDown(0.4);
      }

      if (section.content) {
        const paras = section.content.split(/\n{2,}/).filter(Boolean);
        for (const para of paras) {
          const trimmed = para.trim();
          const lines = trimmed.split("\n");
          const allBullets = lines.every((l) => /^[-•*]\s/.test(l.trim()));

          if (allBullets) {
            for (const line of lines) {
              const text = line.replace(/^[-•*]\s+/, "").trim();
              if (!text) continue;
              const bulletY = doc.y;
              doc
                .save()
                .circle(MARGIN + 5, bulletY + 5, 2)
                .fillColor("#6366F1")
                .fill()
                .restore();
              doc
                .font("Helvetica")
                .fontSize(11)
                .fillColor("#374151")
                .text(text, MARGIN + 14, bulletY, { width: CONTENT_W - 14, lineGap: 2 });
              doc.moveDown(0.2);
            }
            doc.moveDown(0.4);
          } else {
            doc
              .font("Helvetica")
              .fontSize(11)
              .fillColor("#374151")
              .text(trimmed, MARGIN, doc.y, { width: CONTENT_W, align: "justify", lineGap: 3 });
            doc.moveDown(0.5);
          }
        }
      }

      if (section.bullets && section.bullets.length > 0) {
        for (const bullet of section.bullets) {
          const trimmed = bullet.trim();
          if (!trimmed) continue;
          const bulletY = doc.y;
          doc
            .save()
            .circle(MARGIN + 5, bulletY + 5, 2)
            .fillColor("#6366F1")
            .fill()
            .restore();
          doc
            .font("Helvetica")
            .fontSize(11)
            .fillColor("#374151")
            .text(trimmed, MARGIN + 14, bulletY, { width: CONTENT_W - 14, lineGap: 2 });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.5);
      }

      doc.moveDown(0.4);
    }

    // Stamp page numbers on every page now that all content is buffered
    const range = doc.bufferedPageRange();
    const totalPages = range.count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(range.start + i);
      doc
        .save()
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#9CA3AF")
        .text(`Page ${i + 1} of ${totalPages}`, MARGIN, doc.page.height - 40, {
          width: CONTENT_W,
          align: "center",
        })
        .restore();
    }

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse the model's JSON reply defensively. Despite response_format json_object,
 * a reply can still arrive wrapped in a code fence or — when a large dataset
 * extraction hits the token cap — truncated mid-array. A plain JSON.parse throws
 * and 500s the request, so we strip fences and, as a last resort, trim the
 * string back to the last complete top-level structure before re-parsing.
 * Returns {} when nothing salvageable remains (callers degrade to defaults).
 */
export function safeParseFileJson(raw: string): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) return {};

  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Best-effort repair for a response truncated mid-array/object: close any
    // unterminated string, drop a trailing partial element, then balance the
    // open brackets/braces in reverse order.
    const repaired = repairTruncatedJson(cleaned);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

export function hasUsableFileJson(parsed: Record<string, unknown>, format: FileFormat): boolean {
  if (format === "csv" || format === "xlsx") {
    const headers = Array.isArray(parsed.headers)
      ? parsed.headers.map((h) => String(h ?? "").trim()).filter(Boolean)
      : [];
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    return headers.length > 0 && rows.some((r) => Array.isArray(r) && r.length > 0);
  }

  if (format === "pptx") {
    const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
    return slides.some((slide) => {
      if (!slide || typeof slide !== "object") return false;
      const s = slide as Record<string, unknown>;
      const heading = String(s.heading ?? "").trim();
      const bullets = Array.isArray(s.bullets)
        ? s.bullets.map((b) => String(b ?? "").trim()).filter(Boolean)
        : [];
      return heading.length > 0 || bullets.length > 0;
    });
  }

  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  return sections.some((section) => {
    if (!section || typeof section !== "object") return false;
    const s = section as Record<string, unknown>;
    const content = String(s.content ?? "").trim();
    const bullets = Array.isArray(s.bullets)
      ? s.bullets.map((b) => String(b ?? "").trim()).filter(Boolean)
      : [];
    return content.length > 0 || bullets.length > 0;
  });
}

function repairTruncatedJson(s: string): string | null {
  // Walk the string tracking structure depth, ignoring brackets inside strings.
  // Each time we close a bracket we record that index together with a snapshot
  // of the still-open stack at that point — that's the last position where the
  // JSON was structurally complete and can be cleanly closed.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastIndex = -1;
  let lastOpenStack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      lastIndex = i;
      lastOpenStack = [...stack];
    }
  }

  if (stack.length === 0) return null; // already balanced — repair won't help
  if (lastIndex < 0) return null; // never saw a complete structure to fall back to

  // Truncate to the last complete structure, drop any trailing comma the cut
  // left behind, then close the brackets that were still open at that point.
  const body = s.slice(0, lastIndex + 1).replace(/,\s*$/, "");
  let closers = "";
  for (let i = lastOpenStack.length - 1; i >= 0; i--) {
    closers += lastOpenStack[i] === "{" ? "}" : "]";
  }
  return body + closers;
}

function isNonEnglishLanguage(value: string | undefined): boolean {
  if (!value || value === "auto") return false;
  const primary = value.split(",")[0].trim().split("-")[0].toLowerCase();
  return !!primary && primary !== "en";
}

export async function generateFileFromPrompt(
  message: string,
  format: FileFormat,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
  hasSourceData = false,
  subscriptionTier?: string | null,
): Promise<GeneratedFileResult> {
  const isTabular = format === "csv" || format === "xlsx";
  const isPptx = format === "pptx";
  const planTier = normalizeOraPlanTier(subscriptionTier);
  const quality = resolveOraFileQualityProfile({ format, planTier, hasSourceData });

  let systemPrompt: string;
  if (isTabular) {
    systemPrompt = buildTabularSystemPrompt(
      format as "csv" | "xlsx",
      language,
      hasSourceData,
      quality,
    );
  } else if (isPptx) {
    systemPrompt = buildPresentationSystemPrompt(language, hasSourceData, quality);
  } else {
    systemPrompt = buildDocumentSystemPrompt(
      format as "docx" | "pdf",
      language,
      hasSourceData,
      quality,
    );
  }

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...history.slice(-10),
    { role: "user" as const, content: message },
  ];

  const openaiModel = openAiModelForOraFile("generation", planTier);
  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  const candidates: ModelCandidate[] = selectOraFileModelRoute({
    task: "generation",
    subscriptionTier: planTier,
    topic: isTabular ? "technical" : "general",
    multilingual: isNonEnglishLanguage(language),
    hasDocumentContext: hasSourceData,
    available,
    openCircuits,
    openaiModel,
  });

  const chain = await runCandidateChain(candidates, async (candidate) => {
    const result = await createChatCompletion({
      provider: candidate.provider,
      model: candidate.model,
      messages: callMessages,
      response_format: { type: "json_object" },
      // Higher cap so extracting a real dataset into a file isn't truncated
      // mid-JSON (which previously threw on parse and 500'd the request).
      max_completion_tokens: quality.maxCompletionTokens,
    });

    const raw = result.choices[0]?.message?.content?.trim() ?? "";
    const parsed = safeParseFileJson(raw);
    if (Object.keys(parsed).length === 0 || !hasUsableFileJson(parsed, format)) {
      throw new Error("unusable file-generation JSON");
    }
    return parsed;
  });
  const aiData = chain.result;

  let fileBuffer: Buffer;
  // eslint-disable-next-line no-useless-assignment
  let title = "file";
  let rowCount = 0;
  let sectionCount = 0;
  let slideCount = 0;

  if (isTabular) {
    const rawHeaders = Array.isArray(aiData.headers)
      ? (aiData.headers as string[]).map((h) => String(h).trim()).filter(Boolean)
      : ["Column A"];
    const colCount = rawHeaders.length;

    const rawColTypes = Array.isArray(aiData.columnTypes)
      ? (aiData.columnTypes as string[]).map((t) =>
          ["text", "number", "currency", "date", "percent"].includes(t)
            ? (t as ColumnType)
            : "text",
        )
      : undefined;

    const rawRows = Array.isArray(aiData.rows) ? (aiData.rows as unknown[]) : [];
    const normalizedRows = rawRows
      .filter((r) => Array.isArray(r) && (r as unknown[]).length > 0)
      .map((r) => {
        const cells = (r as unknown[]).map((v) => String(v ?? "").trim());
        while (cells.length < colCount) cells.push("");
        return cells.slice(0, colCount);
      });

    const data: TabularData = {
      title: String(aiData.title ?? "Data"),
      sheetName: String(aiData.sheetName ?? "Sheet1"),
      headers: rawHeaders,
      columnTypes: rawColTypes,
      rows: normalizedRows,
    };
    title = data.title;
    rowCount = data.rows.length;
    // When the user attached real data, an empty extraction means the model
    // (or a truncated/invalid reply) lost it. Fail loudly rather than handing
    // back an empty/fabricated file — that was the original "wrong data" bug.
    if (hasSourceData && rowCount === 0) {
      throw new FileGenerationError(
        "Could not extract the data from your file. Please try again, or re-upload it.",
      );
    }
    fileBuffer = format === "csv" ? await buildCsv(data) : await buildXlsx(data);
  } else if (isPptx) {
    const rawSlides = Array.isArray(aiData.slides) ? aiData.slides : [];
    const data: PresentationData = {
      title: String(aiData.title ?? "Presentation"),
      subtitle: aiData.subtitle != null ? String(aiData.subtitle) : undefined,
      slides: (rawSlides as Record<string, unknown>[]).map((s) => ({
        heading: s.heading != null ? String(s.heading).trim() : "Slide",
        bullets: Array.isArray(s.bullets)
          ? (s.bullets as unknown[]).map((b) => String(b).trim()).filter(Boolean)
          : [],
      })),
    };
    title = data.title;
    slideCount = data.slides.length;
    if (hasSourceData && slideCount === 0) {
      throw new FileGenerationError(
        "Could not build slides from your file. Please try again, or re-upload it.",
      );
    }
    fileBuffer = await buildPptx(data);
  } else {
    const rawSections = Array.isArray(aiData.sections) ? aiData.sections : [];
    const data: DocumentData = {
      title: String(aiData.title ?? "Document"),
      subtitle: aiData.subtitle != null ? String(aiData.subtitle) : undefined,
      sections: (rawSections as Record<string, unknown>[]).map((s) => ({
        heading: s.heading != null ? String(s.heading) : undefined,
        content: s.content != null ? String(s.content) : "",
        bullets: Array.isArray(s.bullets)
          ? (s.bullets as unknown[]).map((b) => String(b).trim()).filter(Boolean)
          : undefined,
      })),
    };
    title = data.title;
    sectionCount = data.sections.length;
    if (hasSourceData && sectionCount === 0) {
      throw new FileGenerationError(
        "Could not build a document from your file. Please try again, or re-upload it.",
      );
    }
    fileBuffer = format === "docx" ? await buildDocx(data) : await buildPdf(data);
  }

  const formatLabel = format.toUpperCase();
  const summary = isTabular
    ? `${rowCount} row${rowCount !== 1 ? "s" : ""}`
    : isPptx
      ? `${slideCount} slide${slideCount !== 1 ? "s" : ""}`
      : `${sectionCount} section${sectionCount !== 1 ? "s" : ""}`;

  return {
    fileName: safeFileName(title, format),
    fileData: fileBuffer.toString("base64"),
    mimeType: mimeForFormat(format),
    reply: `Here's your ${formatLabel} file -- "${title}" (${summary}). Click the card below to download it.`,
    rowCount,
    sectionCount,
    slideCount,
  };
}
