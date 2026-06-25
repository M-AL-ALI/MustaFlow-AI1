/**
 * Deterministic Markdown -> structured-data converters for the no-charge file
 * export endpoint. These take the Markdown a caller already has (e.g. an Ora
 * assistant reply on mobile) and shape it into the {@link DocumentData},
 * {@link PresentationData}, and {@link TabularData} inputs accepted by the
 * deterministic builders in `file-builder.ts`.
 *
 * Intentionally pure and AI-free: no model calls, no network, no quota. Inline
 * Markdown emphasis/links/code spans are stripped so exported Office files have
 * no leftover raw symbols, mirroring the website's export polish.
 */

import type {
  DocumentData,
  DocumentSection,
  PresentationData,
  PresentationSlide,
  TabularData,
} from "./file-builder";

const MAX_SECTIONS = 80;
const MAX_SLIDES = 40;
const MAX_BULLETS_PER_SLIDE = 14;
const MAX_TABLE_ROWS = 1000;
const MAX_TABLE_COLS = 30;
const MAX_BULLET_LEN = 400;
const MAX_FALLBACK_CHARS = 4000;

type Token =
  | { type: "heading"; level: number; text: string }
  | { type: "bullet"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "para"; text: string };

/** Strip common inline Markdown so exported text contains no raw symbols. */
export function stripInlineMarkdown(input: string): string {
  return input
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

function parseTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => stripInlineMarkdown(cell.trim()));
}

/** A Markdown table separator line such as `| --- | :--: |` or `---|---`. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-")) return false;
  if (!/^[\s|:-]+$/.test(t)) return false;
  return t.replace(/[\s|:]/g, "").length >= 2;
}

/**
 * Tokenize Markdown into a flat block list. Fenced code blocks are preserved as
 * plain paragraphs (real code in a reply is kept, not dropped). Headings,
 * bullet/ordered lists, and pipe tables are recognized; everything else folds
 * into paragraphs split on blank lines.
 */
export function tokenizeMarkdown(markdown: string): Token[] {
  const tokens: Token[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    const text = stripInlineMarkdown(para.join(" ").replace(/\s+/g, " "));
    if (text) tokens.push({ type: "para", text });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = i < lines.length ? lines[i] : "";
    const trimmed = line.trim();
    const isFence = trimmed.startsWith("```");

    if (inFence) {
      if (isFence) {
        const code = fenceLines.join("\n").trim();
        if (code) tokens.push({ type: "para", text: code });
        fenceLines = [];
        inFence = false;
      } else {
        fenceLines.push(line);
      }
      i++;
      continue;
    }

    if (isFence) {
      flushPara();
      inFence = true;
      fenceLines = [];
      i++;
      continue;
    }

    if (trimmed === "") {
      flushPara();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      flushPara();
      tokens.push({
        type: "heading",
        level: heading[1].length,
        text: stripInlineMarkdown(heading[2]),
      });
      i++;
      continue;
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
    if (trimmed.includes("|") && isTableSeparator(nextLine)) {
      flushPara();
      const headers = parseTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (rowLine === "" || !rowLine.includes("|")) break;
        rows.push(parseTableRow(lines[i]));
        i++;
        if (rows.length >= MAX_TABLE_ROWS) break;
      }
      tokens.push({ type: "table", headers, rows });
      continue;
    }

    const listItem = /^\s*[-*+]\s+(.+)$/.exec(line) ?? /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (listItem) {
      flushPara();
      tokens.push({ type: "bullet", text: stripInlineMarkdown(listItem[1]) });
      i++;
      continue;
    }

    para.push(trimmed);
    i++;
  }

  flushPara();
  if (inFence && fenceLines.length > 0) {
    const code = fenceLines.join("\n").trim();
    if (code) tokens.push({ type: "para", text: code });
  }
  return tokens;
}

function normalizeTable(
  headers: string[],
  rows: string[][],
): { headers: string[]; rows: string[][] } | null {
  const h = headers.slice(0, MAX_TABLE_COLS).map((c) => c.trim());
  if (h.length === 0 || h.every((c) => c === "")) return null;
  const width = h.length;
  const normalizedRows = rows
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => {
      const cells = row.slice(0, width).map((c) => c.trim());
      while (cells.length < width) cells.push("");
      return cells;
    })
    .filter((row) => row.some((c) => c !== ""));
  if (normalizedRows.length === 0) return null;
  return { headers: h, rows: normalizedRows };
}

function fallbackText(markdown: string): string {
  return stripInlineMarkdown(markdown).slice(0, MAX_FALLBACK_CHARS) || "No content.";
}

/** Convert Markdown into a Word/PDF document structure. */
export function markdownToDocumentData(markdown: string, title: string): DocumentData {
  const tokens = tokenizeMarkdown(markdown);
  const sections: DocumentSection[] = [];
  let current: DocumentSection | null = null;

  const ensure = (): DocumentSection => {
    if (!current) {
      current = { content: "" };
      sections.push(current);
    }
    return current;
  };

  for (const tok of tokens) {
    if (sections.length >= MAX_SECTIONS) break;
    if (tok.type === "heading") {
      current = { heading: tok.text || "Section", content: "" };
      sections.push(current);
    } else if (tok.type === "para") {
      const sec = ensure();
      sec.content = sec.content ? `${sec.content}\n\n${tok.text}` : tok.text;
    } else if (tok.type === "bullet") {
      const sec = ensure();
      (sec.bullets ??= []).push(tok.text);
    } else if (tok.type === "table") {
      const tbl = normalizeTable(tok.headers, tok.rows);
      if (!tbl) continue;
      if (current && !current.table) {
        current.table = tbl;
      } else {
        current = { content: "", table: tbl };
        sections.push(current);
      }
    }
  }

  const cleaned = sections.filter(
    (s) => (s.content && s.content.trim()) || (s.bullets && s.bullets.length > 0) || s.table,
  );
  if (cleaned.length === 0) {
    cleaned.push({ content: fallbackText(markdown) });
  }
  return { title: title.trim() || "Ora Export", sections: cleaned };
}

/** Convert Markdown into a slide-deck structure. */
export function markdownToPresentationData(markdown: string, title: string): PresentationData {
  const tokens = tokenizeMarkdown(markdown);
  const slides: PresentationSlide[] = [];
  let current: PresentationSlide | null = null;

  const addBullet = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    if (!current) {
      current = { heading: "Overview", bullets: [] };
      slides.push(current);
    }
    if (current.bullets.length >= MAX_BULLETS_PER_SLIDE) return;
    current.bullets.push(t.length > MAX_BULLET_LEN ? `${t.slice(0, MAX_BULLET_LEN)}\u2026` : t);
  };

  for (const tok of tokens) {
    if (slides.length >= MAX_SLIDES) break;
    if (tok.type === "heading") {
      current = { heading: tok.text || "Slide", bullets: [] };
      slides.push(current);
    } else if (tok.type === "bullet") {
      addBullet(tok.text);
    } else if (tok.type === "para") {
      const sentences = tok.text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const s of sentences) addBullet(s);
    } else if (tok.type === "table") {
      for (const row of tok.rows.slice(0, MAX_BULLETS_PER_SLIDE)) {
        addBullet(row.filter(Boolean).join(" \u2014 "));
      }
    }
  }

  const cleaned = slides.filter((s) => s.bullets.length > 0);
  if (cleaned.length === 0) {
    cleaned.push({
      heading: "Summary",
      bullets: [fallbackText(markdown).slice(0, MAX_BULLET_LEN)],
    });
  }
  return { title: title.trim() || "Ora Presentation", slides: cleaned };
}

/** Convert Markdown into a spreadsheet structure (prefers a real table). */
export function markdownToTabularData(markdown: string, title: string): TabularData {
  const tokens = tokenizeMarkdown(markdown);
  const resolvedTitle = title.trim() || "Ora Data";

  const tables = tokens.filter((t): t is Extract<Token, { type: "table" }> => t.type === "table");
  if (tables.length > 0) {
    const best = tables.reduce((a, b) =>
      b.rows.length * b.headers.length > a.rows.length * a.headers.length ? b : a,
    );
    const tbl = normalizeTable(best.headers, best.rows);
    if (tbl) {
      return { title: resolvedTitle, sheetName: "Data", headers: tbl.headers, rows: tbl.rows };
    }
  }

  // No usable table: build a Section/Content sheet from headings + text so the
  // workbook is always real and non-empty.
  const rows: string[][] = [];
  let heading = "";
  for (const tok of tokens) {
    if (rows.length >= MAX_TABLE_ROWS) break;
    if (tok.type === "heading") {
      heading = tok.text;
    } else if (tok.type === "para" || tok.type === "bullet") {
      rows.push([heading, tok.text]);
    } else if (tok.type === "table") {
      for (const r of tok.rows) {
        if (rows.length >= MAX_TABLE_ROWS) break;
        rows.push([heading, r.filter(Boolean).join(" \u2014 ")]);
      }
    }
  }
  if (rows.length === 0) {
    return {
      title: resolvedTitle,
      sheetName: "Data",
      headers: ["Content"],
      rows: [[fallbackText(markdown)]],
    };
  }
  const hasHeadings = rows.some((r) => r[0] !== "");
  if (hasHeadings) {
    return { title: resolvedTitle, sheetName: "Data", headers: ["Section", "Content"], rows };
  }
  return {
    title: resolvedTitle,
    sheetName: "Data",
    headers: ["Content"],
    rows: rows.map((r) => [r[1]]),
  };
}
