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

  it("keeps PlusMenu scoped to attachment and file creation, not response mode", () => {
    const menuStart = index.indexOf("function PlusMenu({");
    expect(menuStart).toBeGreaterThan(-1);
    const menuEnd = index.indexOf("\nfunction OraHeaderMenu", menuStart);
    const menuBody = index.slice(menuStart, menuEnd);

    expect(index).toContain('accessibilityLabel="Add attachment or create file"');
    expect(menuBody).toContain('SheetSectionLabel label="Attach"');
    expect(menuBody).toContain('SheetSectionLabel label="Create"');
    expect(menuBody).not.toContain('SheetSectionLabel label="Tools"');
    expect(menuBody).not.toContain('label="Instant"');
    expect(menuBody).not.toContain('label="Deep Thinking"');
    expect(menuBody).not.toContain("onSelectMode");
  });

  it("GenerateFileSheet offers every server format", () => {
    expect(index).toContain("function GenerateFileSheet(");
    expect(index).toContain("GENERATE_FILE_FORMATS");
    for (const fmt of ["docx", "pdf", "xlsx", "csv", "pptx", "md"]) {
      expect(index).toContain(`value: "${fmt}"`);
    }
  });

  it("auto-routes explicit file requests and validates a real artifact before showing a card", () => {
    expect(index).toContain("detectExplicitOraFileRequest(text)");
    expect(index).toContain("detectOraUploadedFileModification(text, attachment.filename)");
    expect(index).toContain("if (!isSuccessfulOraGeneratedFilePayload(res))");
    expect(index).toContain("generation returned no artifact");
  });

  it("round-trips uploaded image edits through the image-edit endpoint", () => {
    expect(api).toContain('"/api/public-ai/image-edit"');
    expect(index).toContain("isOraUploadedImageEditRequest(prompt)");
    expect(index).toContain("await editUploadedImage(attch.ref, prompt)");
    expect(index).toContain("if (!res.imageUrl)");
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

  it("supports revising a generated file through the same generate-file sheet", () => {
    expect(index).toContain("const [generateFileDraft, setGenerateFileDraft]");
    expect(index).toContain("const handleReviseGeneratedFile = useCallback((file: GeneratedFile)");
    expect(index).toContain(
      'prompt: `Revise the ${file.format.toUpperCase()} file "${file.fileName}": `',
    );
    expect(index).toContain("format: file.format");
    expect(index).toContain("onReviseFile={handleReviseGeneratedFile}");
    expect(index).toContain('initialPrompt={generateFileDraft?.prompt ?? ""}');
    expect(index).toContain('initialFormat={generateFileDraft?.format ?? "docx"}');
  });

  it("renders separate save/download and Revise actions on generated-file cards", () => {
    expect(index).toContain("onReviseFile?: (file: GeneratedFile) => void;");
    // Images keep "Save"; documents are labeled "Download" for website parity.
    expect(index).toContain('"Save generated file"');
    expect(index).toContain('"Download generated file"');
    // The card reads from the restore-aware `generatedFile` (repointed after a
    // version restore), not the raw message copy.
    expect(index).toContain('{isImageFile(generatedFile.mimeType) ? "Save" : "Download"}');
    expect(index).toContain('accessibilityLabel="Revise generated file"');
    expect(index).toContain("<Pencil size={15} color={c.accentForeground} />");
    expect(index).toContain("<Text");
    expect(index).toContain("Revise");
  });

  it("confirms generated-file save/download outcomes to the user", () => {
    expect(index).toContain("function generatedFileSaveConfirmation");
    expect(index).toContain('"Image saved to your photo library."');
    expect(index).toContain("`${file.fileName} is ready in the share sheet.`");
    expect(index).toContain("`Opened download for ${file.fileName}.`");
    expect(index).toContain(
      'Alert.alert("Saved", generatedFileSaveConfirmation(generatedFile, outcome))',
    );
  });

  it("renders a View action on non-image generated-file cards (website parity)", () => {
    // View button only for non-image files, wired to handleViewFile.
    expect(index).toContain('accessibilityLabel="View generated file"');
    expect(index).toContain("onPress={handleViewFile}");
    const viewFnStart = index.indexOf("const handleViewFile = useCallback(");
    expect(viewFnStart).toBeGreaterThan(-1);
    const viewFnEnd = index.indexOf("\n  );", viewFnStart);
    const viewFnBody = index.slice(viewFnStart, viewFnEnd);
    // Web opens the file directly; native materializes to cache first.
    expect(viewFnBody).toContain('Platform.OS === "web"');
    expect(viewFnBody).toContain("await materializeGeneratedFileToCache(file)");
    // iOS in-app WebView preview when available, share sheet otherwise.
    expect(viewFnBody).toContain("canViewFileInApp()");
    expect(viewFnBody).toContain("setFileViewerUri(uri)");
    expect(viewFnBody).toContain("await shareCachedFile(uri, mimeType)");
    // The viewer modal is rendered for the card.
    expect(index).toContain("<GeneratedFileViewer");
    expect(index).toContain("uri={fileViewerUri}");
    expect(index).toContain("onClose={() => setFileViewerUri(null)}");
  });

  it("opens normal Create-file requests with an empty draft", () => {
    const plusStart = index.indexOf("<PlusMenu");
    expect(plusStart).toBeGreaterThan(-1);
    const sheetStart = index.indexOf("<GenerateFileSheet", plusStart);
    const between = index.slice(plusStart, sheetStart);
    expect(between).toContain("setGenerateFileDraft(null)");
    expect(between).toContain("setShowGenerateFile(true)");
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

  it("preserves full dataset-analysis results and renders analyst workflow cues", () => {
    const datasetBranchStart = index.indexOf('} else if (attch.kind === "dataset")');
    expect(datasetBranchStart).toBeGreaterThan(-1);
    const datasetBranch = index.slice(datasetBranchStart, datasetBranchStart + 1600);

    expect(datasetBranch).toContain("...result");
    expect(datasetBranch).toContain("datasetResult:");

    const extras = read("../../components/ora/MessageExtras.tsx");
    expect(extras).toContain("<OraDatasetWorkflow result={message.datasetResult} c={c} />");
    expect(extras).toContain("workflow.chartSuggestions");
    expect(extras).toContain("workflow.calculationSuggestions");
    expect(extras).toContain("workflow.reportSuggestions");
    expect(extras).toContain("Reports ready:");
  });

  it("exports analyst workflow sections into mobile Office/PDF report payloads", () => {
    expect(index).toContain("function datasetGeneratedChartsMarkdown(");
    expect(index).toContain('"## Generated Charts"');
    expect(index).toContain('"Pareto Contribution"');
    expect(index).toContain('"Risk Score by Issue"');
    expect(index).toContain("`### ${block.title}`");
    expect(index).toContain("function textBar(");
    expect(index).toContain("function datasetWorkflowMarkdown(");
    expect(index).toContain('"## Suggested Charts"');
    expect(index).toContain('"## Repeatable Calculations"');
    expect(index).toContain('"## Downloadable Reports"');

    const markdownStart = index.indexOf("function messageMarkdown(");
    const markdownBody = index.slice(markdownStart, markdownStart + 1800);
    expect(markdownBody).toContain("datasetGeneratedChartsMarkdown(message.datasetResult)");
    expect(markdownBody).toContain("datasetWorkflowMarkdown(message.datasetResult)");
    expect(markdownBody).toContain("includeDatasetJson !== false");

    for (const format of ["docx", "xlsx", "pptx", "pdf"]) {
      const formatIdx = index.indexOf(`format: "${format}"`);
      expect(formatIdx).toBeGreaterThan(-1);
      const block = index.slice(formatIdx, formatIdx + 360);
      expect(block).toContain("messageMarkdown(message, { includeDatasetJson: false })");
    }
  });

  it("passes the PDF UTI to native share/save so iOS treats server PDFs as files", () => {
    const files = read("../files.ts");
    expect(files).toContain("function fileUtiForMime(");
    expect(files).toContain('"application/pdf"');
    expect(files).toContain('"com.adobe.pdf"');
    expect(files).toContain("shareFile(fileUri, file.mimeType, fileUtiForMime(file.mimeType))");
  });
});
