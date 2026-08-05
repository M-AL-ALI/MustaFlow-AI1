import { describe, expect, it } from "vitest";
import {
  buildMarkdown,
  generatedFileNameForPrompt,
  normalizeDocumentFileData,
} from "../file-builder";

describe("Ora generated-file contract", () => {
  it("preserves an explicitly requested filename for every supported format", () => {
    for (const format of ["csv", "xlsx", "docx", "pdf", "pptx", "md"] as const) {
      expect(
        generatedFileNameForPrompt(
          `Create a file named ora-test.${format} containing the requested content`,
          "Ignored title",
          format,
        ),
      ).toBe(`ora-test.${format}`);
    }
  });

  it("writes requested sections, bullets, tables, and chart data into Markdown bytes", () => {
    const document = normalizeDocumentFileData({
      title: "Ora Test",
      sections: [
        {
          heading: "Summary",
          content: "The requested section is present.",
          bullets: ["First point", "Second point", "Third point"],
          table: { headers: ["Name", "Value"], rows: [["Alpha", "42"]] },
          chart: {
            title: "Totals",
            chartType: "bar",
            labels: ["Alpha", "Beta"],
            values: [42, 21],
          },
        },
      ],
    });
    const markdown = buildMarkdown(document).toString("utf8");

    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("- Third point");
    expect(markdown).toContain("| Alpha | 42 |");
    expect(markdown).toContain("### Totals");
  });
});
