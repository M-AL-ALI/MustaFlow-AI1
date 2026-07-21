import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too
// (the canonical Linux/Replit checkout is LF, but contributors edit on Windows).
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Ora — file edit-quality card parity (Phase A)", () => {
  const types = read("../types.ts");
  const index = read("../../app/(home)/index.tsx");

  it("ChatResponse carries the optional editQuality payload from the wire", () => {
    const chatResponseStart = types.indexOf("export interface ChatResponse {");
    expect(chatResponseStart).toBeGreaterThan(-1);
    const chatResponseEnd = types.indexOf("\nexport ", chatResponseStart + 1);
    const chatResponseBody = types.slice(chatResponseStart, chatResponseEnd);
    expect(chatResponseBody).toContain("editQuality?: OraFileEditQuality;");
  });

  it("editQuality type is imported type-only from the shared ora-contracts wire types", () => {
    // Type-only import keeps the zod runtime out of the Metro bundle.
    expect(types).toContain("OraFileEditQuality");
    const importBlock = types.slice(
      types.indexOf("import type {"),
      types.indexOf('} from "@workspace/ora-contracts";', types.indexOf("import type {")),
    );
    expect(importBlock).toContain("OraFileEditQuality");
  });

  it("buildGeneratedFile picks editQuality off the response and carries it onto the message", () => {
    const fnStart = index.indexOf("function buildGeneratedFile(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = index.slice(fnStart, fnStart + 1200);
    expect(fnBody).toContain('"editQuality"');
    expect(fnBody).toContain("...(res.editQuality ? { editQuality: res.editQuality } : {})");
  });

  it("describeEditQuality maps all four edit modes to honest user-facing labels", () => {
    const fnStart = index.indexOf("function describeEditQuality(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = index.slice(fnStart, index.indexOf("\nfunction ", fnStart + 1));
    expect(fnBody).toContain('case "original_edited":');
    expect(fnBody).toContain('case "unchanged":');
    expect(fnBody).toContain('case "redesigned":');
    expect(fnBody).toContain('case "failed_safe":');
    expect(fnBody).toContain("Edited your original file");
    expect(fnBody).toContain("Original file returned unchanged");
    expect(fnBody).toContain("Rebuilt from your content");
    expect(fnBody).toContain("Edit not applied — original returned unchanged");
    // Layout claim is only shown when the server did NOT flag layout loss.
    expect(fnBody).toContain("quality.preservedLayout === false");
  });

  it("renders the compact quality card off message.generatedFile.editQuality", () => {
    expect(index).toContain("const quality = message.generatedFile?.editQuality;");
    expect(index).toContain("describeEditQuality(quality)");
  });

  it("surfaces the server warning and caps visible change lines at three", () => {
    const cardStart = index.indexOf("const quality = message.generatedFile?.editQuality;");
    expect(cardStart).toBeGreaterThan(-1);
    const cardBody = index.slice(cardStart, cardStart + 4500);
    expect(cardBody).toContain("quality.warning");
    expect(cardBody).toContain("changes.slice(0, 3)");
    expect(cardBody).toContain("hiddenCount");
  });
});
