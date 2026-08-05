import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  detectExplicitOraFileRequest,
  isSuccessfulOraGeneratedFilePayload,
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
    ).toEqual({ format: "md", requestedFileName: "ora-test.md" });

    const panel = read("../../components/ora-panel.tsx");
    expect(panel).toContain("detectExplicitOraFileRequest(text)");
    expect(panel).toContain(
      "void generateFile(text, uploadedEditFormat ?? explicitFileRequest!.format)",
    );
  });

  it("requires real filename, bytes, and MIME before treating generation as successful", () => {
    expect(
      isSuccessfulOraGeneratedFilePayload({
        fileName: "ora-test.md",
        fileData: "IyBUZXN0",
        mimeType: "text/markdown",
      }),
    ).toBe(true);
    expect(
      isSuccessfulOraGeneratedFilePayload({
        reply: "Your download card is ready",
        fileName: "ora-test.md",
      }),
    ).toBe(false);

    const chat = read("../use-ora-chat.ts");
    expect(chat).toContain("if (!isSuccessfulOraGeneratedFilePayload(data))");
    expect(chat).toContain("I couldn't generate the requested file.");
  });
});
