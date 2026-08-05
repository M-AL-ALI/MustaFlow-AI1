import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  detectExplicitOraFileRequest,
  isSuccessfulOraGeneratedFilePayload,
  resolveOraFileFormatRequest,
} from "@workspace/ora-contracts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) =>
  readFileSync(path.join(dirname, relativePath), "utf8").replace(/\r\n/g, "\n");

describe("Ora web file-generation contract", () => {
  it("routes an explicit named Markdown request to the file pipeline", () => {
    expect(
      detectExplicitOraFileRequest(
        "Create a file named ora-test.md containing three bullet points and give me the download",
      ),
    ).toEqual({
      format: "md",
      requestedFileName: "ora-test.md",
      requestedExtension: "md",
    });

    const panel = read("../../components/ora-panel.tsx");
    expect(panel).toContain("detectExplicitOraFileRequest(text)");
    expect(panel).toContain("explicitFileRequest!.requestedExtension");
  });

  it("routes TXT directly and keeps unsupported named formats out of PDF", () => {
    expect(detectExplicitOraFileRequest("Create a file named ora-test.txt")).toMatchObject({
      format: "txt",
      requestedFileName: "ora-test.txt",
    });
    expect(resolveOraFileFormatRequest("Create a file named ora-test.exe", "pdf")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_FILE_FORMAT",
    });
  });

  it("requires real filename, bytes, and MIME before treating generation as successful", () => {
    expect(
      isSuccessfulOraGeneratedFilePayload(
        {
          fileName: "ora-test.md",
          fileData: "IyBUZXN0",
          mimeType: "text/markdown",
        },
        { format: "md", requestedFileName: "ora-test.md" },
      ),
    ).toBe(true);
    expect(
      isSuccessfulOraGeneratedFilePayload({
        reply: "Your download card is ready",
        fileName: "ora-test.md",
      }),
    ).toBe(false);

    const chat = read("../use-ora-chat.ts");
    expect(chat).toContain("resolveOraFileFormatRequest(content, format)");
    expect(chat).toContain("No download card was shown.");
    const panel = read("../../components/ora-panel.tsx");
    expect(panel).toContain('window.open("about:blank", "_blank")');
    expect(panel).toContain("preview.location.href = url");
  });
});
