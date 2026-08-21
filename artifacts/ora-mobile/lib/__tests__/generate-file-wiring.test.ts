import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractIfStatementByCondition,
  extractNamedDeclaration,
  extractNamedFunction,
  extractObjectLiteralByStringProperty,
  extractUniqueJsxElementByName,
} from "../../../api-server/src/lib/source-ast-test-helper";

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
    const fnBody = extractNamedFunction(api, "generateFile");
    expect(fnBody).toContain("function generateFile");
    expect(fnBody).toContain('method: "POST"');
    expect(fnBody).toContain("message: req.message");
    expect(fnBody).toContain("messages: req.messages");
    expect(fnBody).toContain("format: req.format");
    expect(fnBody).toContain("documentRefs: req.documentRefs ?? []");
    // Returns the chat-shaped response so the download card + usage reuse it.
    expect(fnBody).toContain("ChatResponse");
  });

  it("generate-file is an auth-guarded route (signed-in user fails closed, anon still works)", () => {
    const pathRequiresAuthFn = extractNamedFunction(api, "pathRequiresAuth");
    expect(pathRequiresAuthFn).toContain('"/api/public-ai/generate-file"');
  });

  it("PlusMenu surfaces a Create-file action wired to open the sheet", () => {
    expect(index).toContain('label="Create file"');
    expect(index).toContain("onGenerateFile");
    expect(index).toContain("setShowGenerateFile(true)");
  });

  it("keeps PlusMenu scoped to attachment and file creation, not response mode", () => {
    const menuBody = extractNamedFunction(index, "PlusMenu", "tsx");
    expect(menuBody).toContain("function PlusMenu");

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
    for (const fmt of ["docx", "pdf", "xlsx", "csv", "pptx", "md", "txt"]) {
      expect(index).toContain(`value: "${fmt}"`);
    }
  });

  it("auto-routes explicit file requests and validates a real artifact before showing a card", () => {
    expect(index).toContain("detectExplicitOraFileRequest(text)");
    expect(index).toContain("detectOraUploadedFileModification(text, attachment.filename)");
    expect(index).toContain("resolveOraFileFormatRequest(text, format)");
    expect(index).toContain("No download card was shown.");
  });

  it("round-trips uploaded image edits through the image-edit endpoint", () => {
    expect(api).toContain('"/api/public-ai/image-edit"');
    expect(index).toContain("isOraUploadedImageEditRequest(prompt)");
    expect(index).toContain("await editUploadedImage(attch.ref, prompt)");
    expect(index).toContain("if (!res.imageUrl)");
  });

  it("handleGenerateFile calls generateFile and renders a downloadable card via buildChatExtras", () => {
    const fnBody = extractNamedDeclaration(index, "handleGenerateFile", "tsx");
    expect(fnBody).toContain("handleGenerateFile = useCallback");
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
    const viewFnBody = extractNamedDeclaration(index, "handleViewFile", "tsx");
    expect(viewFnBody).toContain("handleViewFile = useCallback");
    // Every platform materializes the file; web then opens rather than downloads it.
    expect(viewFnBody).toContain('Platform.OS === "web"');
    expect(viewFnBody).toContain("await materializeGeneratedFileToCache(file)");
    expect(viewFnBody).toContain("await WebBrowser.openBrowserAsync(uri)");
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
    const between = extractUniqueJsxElementByName(index, "PlusMenu");
    expect(between).toContain("<PlusMenu");
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
    const datasetBranch = extractIfStatementByCondition(index, 'attch.kind === "dataset"', "tsx");
    expect(datasetBranch).toContain('attch.kind === "dataset"');

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

    const markdownBody = extractNamedFunction(index, "messageMarkdown", "tsx");
    expect(markdownBody).toContain("datasetGeneratedChartsMarkdown(message.datasetResult)");
    expect(markdownBody).toContain("datasetWorkflowMarkdown(message.datasetResult)");
    expect(markdownBody).toContain("includeDatasetJson !== false");

    for (const format of ["docx", "xlsx", "pptx", "pdf"]) {
      const block = extractObjectLiteralByStringProperty(index, "format", format, "tsx");
      expect(block).toContain(`format: "${format}"`);
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
