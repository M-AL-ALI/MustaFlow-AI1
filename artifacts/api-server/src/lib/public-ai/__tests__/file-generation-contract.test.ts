import { describe, expect, it } from "vitest";
import {
  buildMarkdown,
  buildPlainText,
  generatedFileNameForPrompt,
  normalizeDocumentFileData,
} from "../file-builder";
import {
  isSuccessfulOraGeneratedFilePayload,
  resolveOraFileFormatRequest,
} from "@workspace/ora-contracts";

describe("Ora generated-file contract", () => {
  it("preserves an explicitly requested filename for every supported format", () => {
    for (const format of ["csv", "xlsx", "docx", "pdf", "pptx", "md", "txt"] as const) {
      expect(
        generatedFileNameForPrompt(
          `Create a file named ora-test.${format} containing the requested content`,
          "Ignored title",
          format,
        ),
      ).toBe(`ora-test.${format}`);
    }
  });

  it("writes plain-text output directly and preserves requested content", () => {
    const text = buildPlainText(
      normalizeDocumentFileData({
        title: "Ora Test",
        sections: [{ heading: "Points", bullets: ["One", "Two", "Three"] }],
      }),
    ).toString("utf8");
    expect(text).toContain("Points");
    expect(text).toContain("- Three");
    expect(text).not.toContain("# Ora Test");
  });

  it("makes explicit extensions authoritative and rejects unsupported formats", () => {
    expect(resolveOraFileFormatRequest('Create a file named "ora-test.txt"', "pdf")).toMatchObject({
      ok: true,
      format: "txt",
      requestedFileName: "ora-test.txt",
    });
    expect(resolveOraFileFormatRequest('Create a file named "ora-test.exe"', "pdf")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FILE_FORMAT",
      requestedExtension: "exe",
    });
  });

  it("rejects a generated artifact whose filename or MIME differs from the request", () => {
    const expected = { format: "txt" as const, requestedFileName: "ora-test.txt" };
    expect(
      isSuccessfulOraGeneratedFilePayload(
        { fileName: "ora-test.txt", fileData: "T25l", mimeType: "text/plain; charset=utf-8" },
        expected,
      ),
    ).toBe(true);
    expect(
      isSuccessfulOraGeneratedFilePayload(
        { fileName: "ora-test.pdf", fileData: "T25l", mimeType: "application/pdf" },
        expected,
      ),
    ).toBe(false);
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
