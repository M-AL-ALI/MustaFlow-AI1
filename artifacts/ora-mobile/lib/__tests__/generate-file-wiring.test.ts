import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so source-string assertions pass on Windows checkouts too
// (the canonical Linux/Replit checkout is LF, but contributors edit on Windows).
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Ora — Create file (generate-file) parity", () => {
  const api = read("../api.ts");
  const index = read("../../app/(home)/index.tsx");

  it("api.ts exposes generateFile() pointing at the dedicated endpoint", () => {
    expect(api).toContain("export function generateFile(");
    expect(api).toContain('"/api/public-ai/generate-file"');
    expect(api).toContain("export interface GenerateFileRequest");
  });

  it("generateFile() POSTs message, messages, format, language?, and documentRefs[]", () => {
    const fnStart = api.indexOf("export function generateFile(");
    expect(fnStart).toBeGreaterThan(-1);
    const nextExport = api.indexOf("\nexport ", fnStart + 1);
    const fnBody = nextExport > fnStart ? api.slice(fnStart, nextExport) : api.slice(fnStart);
    expect(fnBody).toContain('method: "POST"');
    expect(fnBody).toContain("message: req.message");
    expect(fnBody).toContain("messages: req.messages");
    expect(fnBody).toContain("format: req.format");
    expect(fnBody).toContain("documentRefs: req.documentRefs ?? []");
    // Returns the chat-shaped response so the download card + usage reuse it.
    expect(fnBody).toContain("ChatResponse");
  });

  it("generate-file is an auth-guarded route (signed-in user fails closed, anon still works)", () => {
    const pathRequiresAuthFn = api.slice(
      api.indexOf("function pathRequiresAuth("),
      api.indexOf("function pathRequiresAuth(") + 1200,
    );
    expect(pathRequiresAuthFn).toContain('"/api/public-ai/generate-file"');
  });

  it("PlusMenu surfaces a Create-file action wired to open the sheet", () => {
    expect(index).toContain('label="Create file"');
    expect(index).toContain("onGenerateFile");
    expect(index).toContain("setShowGenerateFile(true)");
  });

  it("GenerateFileSheet offers all five server formats", () => {
    expect(index).toContain("function GenerateFileSheet(");
    expect(index).toContain("GENERATE_FILE_FORMATS");
    for (const fmt of ["docx", "pdf", "xlsx", "csv", "pptx"]) {
      expect(index).toContain(`value: "${fmt}"`);
    }
  });

  it("handleGenerateFile calls generateFile and renders a downloadable card via buildChatExtras", () => {
    const fnStart = index.indexOf("const handleGenerateFile = useCallback(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = index.indexOf("\n  );", fnStart);
    const fnBody = index.slice(fnStart, fnEnd);
    expect(fnBody).toContain("await generateFile(");
    expect(fnBody).toContain("documentRefs: documentRefsRef.current");
    // The settled assistant turn must spread buildChatExtras so the generated
    // file becomes a downloadable card (generatedFile carries optional assetId).
    expect(fnBody).toContain("...buildChatExtras(res)");
    // Errors must surface on the bubble, not silently drop the turn.
    expect(fnBody).toContain("error: true");
  });

  it("carries Ora image profile metadata from chat responses into message rendering", () => {
    expect(index).toContain("imageMeta: res.imageMeta");
    expect(index).toContain("function formatOraImageMeta(");
    expect(index).toContain("formatOraImageMeta(message.imageMeta)");
  });

  it("preserves Ora image profile metadata when an inline edit creates a new image", () => {
    expect(index).toContain(
      "const sourceImageMeta = messagesRef.current.find((m) => m.imageId === id)?.imageMeta;",
    );
    expect(index).toContain("...(sourceImageMeta ? { imageMeta: sourceImageMeta } : {})");
  });

  it("tracks uploaded document/dataset refs and clears them on every context switch", () => {
    // Refs are accumulated on upload so a later Create-file builds from real data.
    expect(index).toContain("documentRefsRef");
    const uploadIdx = index.indexOf('kind === "document" || kind === "dataset"');
    expect(uploadIdx).toBeGreaterThan(-1);
    // Cleared on new chat, temporary toggle, and conversation load (session-scoped).
    const clears = index.match(/documentRefsRef\.current = \[\]/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });
});
