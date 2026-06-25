/**
 * Unit tests for the deterministic Markdown -> structured-data converters and
 * an end-to-end check that they feed valid Microsoft Office / PDF bytes through
 * the deterministic builders (mobile's real-export path).
 */

import { describe, expect, it } from "vitest";
import {
  markdownToDocumentData,
  markdownToPresentationData,
  markdownToTabularData,
  stripInlineMarkdown,
  tokenizeMarkdown,
} from "../export-content";
import { buildDocx, buildPdf, buildPptx, buildXlsx } from "../file-builder";

const RICH = `# Quarterly Update

Revenue grew **20%** this quarter. See [details](https://example.com).

## Highlights

- Launched the new \`dashboard\`
- Signed two enterprise deals
- Reduced churn

## Metrics

| Region | Revenue | Growth |
| --- | --- | --- |
| North | 120 | 12% |
| South | 80 | 8% |

\`\`\`js
const x = 1;
\`\`\`
`;

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function isPdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe("stripInlineMarkdown", () => {
  it("removes bold, italic, code, links, and images", () => {
    expect(stripInlineMarkdown("**bold**")).toBe("bold");
    expect(stripInlineMarkdown("_italic_")).toBe("italic");
    expect(stripInlineMarkdown("`code`")).toBe("code");
    expect(stripInlineMarkdown("[label](https://x.com)")).toBe("label");
    expect(stripInlineMarkdown("![alt](https://x.com/a.png) caption")).toBe("caption");
  });
});

describe("tokenizeMarkdown", () => {
  it("recognizes headings, bullets, tables, and code", () => {
    const tokens = tokenizeMarkdown(RICH);
    const types = tokens.map((t) => t.type);
    expect(types).toContain("heading");
    expect(types).toContain("bullet");
    expect(types).toContain("table");
    const table = tokens.find((t) => t.type === "table");
    expect(table && table.type === "table" && table.headers).toEqual([
      "Region",
      "Revenue",
      "Growth",
    ]);
    expect(table && table.type === "table" && table.rows.length).toBe(2);
  });

  it("treats ordered list items as bullets", () => {
    const tokens = tokenizeMarkdown("1. first\n2. second");
    expect(tokens.filter((t) => t.type === "bullet")).toHaveLength(2);
  });
});

describe("markdownToDocumentData", () => {
  it("builds titled sections with bullets and a table", () => {
    const data = markdownToDocumentData(RICH, "My Report");
    expect(data.title).toBe("My Report");
    const headings = data.sections.map((s) => s.heading).filter(Boolean);
    expect(headings).toContain("Highlights");
    expect(headings).toContain("Metrics");
    const withBullets = data.sections.find((s) => s.bullets && s.bullets.length > 0);
    expect(withBullets?.bullets).toContain("Reduced churn");
    const withTable = data.sections.find((s) => s.table);
    expect(withTable?.table?.headers).toEqual(["Region", "Revenue", "Growth"]);
  });

  it("falls back to a single section for empty content", () => {
    const data = markdownToDocumentData("   ", "Empty");
    expect(data.sections).toHaveLength(1);
    expect(data.sections[0].content).toBeTruthy();
  });
});

describe("markdownToPresentationData", () => {
  it("makes one slide per heading", () => {
    const data = markdownToPresentationData(RICH, "Deck");
    const headings = data.slides.map((s) => s.heading);
    expect(headings).toContain("Highlights");
    const highlights = data.slides.find((s) => s.heading === "Highlights");
    expect(highlights?.bullets.length).toBeGreaterThan(0);
  });

  it("always yields at least one slide", () => {
    const data = markdownToPresentationData("", "Deck");
    expect(data.slides.length).toBeGreaterThanOrEqual(1);
  });
});

describe("markdownToTabularData", () => {
  it("prefers a real Markdown table", () => {
    const data = markdownToTabularData(RICH, "Data");
    expect(data.headers).toEqual(["Region", "Revenue", "Growth"]);
    expect(data.rows).toHaveLength(2);
  });

  it("falls back to Section/Content when there is no table", () => {
    const data = markdownToTabularData("# Intro\n\nHello world.", "Data");
    expect(data.headers).toEqual(["Section", "Content"]);
    expect(data.rows[0][0]).toBe("Intro");
  });

  it("falls back to a Content column for plain prose", () => {
    const data = markdownToTabularData("Just some prose with no headings.", "Data");
    expect(data.headers).toEqual(["Content"]);
    expect(data.rows.length).toBeGreaterThan(0);
  });
});

describe("end-to-end builder output", () => {
  it("produces a valid .docx (ZIP) from converted Markdown", async () => {
    const buf = await buildDocx(markdownToDocumentData(RICH, "Doc"));
    expect(isZip(buf)).toBe(true);
  });

  it("produces a valid .xlsx (ZIP)", async () => {
    const buf = await buildXlsx(markdownToTabularData(RICH, "Data"));
    expect(isZip(buf)).toBe(true);
  });

  it("produces a valid .pptx (ZIP)", async () => {
    const buf = await buildPptx(markdownToPresentationData(RICH, "Deck"));
    expect(isZip(buf)).toBe(true);
  });

  it("produces a valid .pdf", async () => {
    const buf = await buildPdf(markdownToDocumentData(RICH, "Doc"));
    expect(isPdf(buf)).toBe(true);
  });
});
