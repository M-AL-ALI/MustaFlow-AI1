import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Ora - Phase 9A file/data agent preview parity", () => {
  const types = read("../types.ts");
  const api = read("../api.ts");
  const index = read("../../app/(home)/index.tsx");
  const extras = read("../../components/ora/MessageExtras.tsx");

  it("imports the shared preview type from ora-contracts", () => {
    expect(types).toContain("OraFileAgentPreview");
    const importBlock = types.slice(
      types.indexOf("import type {"),
      types.indexOf('} from "@workspace/ora-contracts";', types.indexOf("import type {")),
    );
    expect(importBlock).toContain("OraFileAgentPreview");
  });

  it("declares preview metadata on chat and stream response contracts", () => {
    expect(types).toContain("fileAgentPreview?: OraFileAgentPreview;");
    expect(api).toContain("fileAgentPreview?: OraFileAgentPreview;");
    expect(api).toContain("fileAgentPreview: resolvedDone.fileAgentPreview");
  });

  it("maps preview metadata onto assistant messages", () => {
    expect(index).toContain(
      "...(res.fileAgentPreview ? { fileAgentPreview: res.fileAgentPreview } : {})",
    );
    expect(index).toContain(
      "...(result.fileAgentPreview ? { fileAgentPreview: result.fileAgentPreview } : {})",
    );
    expect(index).toContain("streamResult.fileAgentPreview");
  });

  it("renders the compact preview card from message or dataset metadata", () => {
    expect(extras).toContain("function OraFileAgentPreviewIndicator");
    expect(extras).toContain("message.fileAgentPreview ?? message.datasetResult?.fileAgentPreview");
    expect(extras).toMatch(/<OraFileAgentPreviewIndicator[\s\S]*message=\{message\}/);
    expect(extras).toContain("preview.plannedActions");
    expect(extras).toContain("preview.calculations");
    expect(extras).toContain("preview.charts");
    expect(extras).toContain('preview.status === "needs_confirmation"');
    expect(extras).toContain("Apply edit");
    expect(extras).toContain("Revise plan");
    expect(extras).toContain("Redesigned copy");
  });

  it("wires preview confirmation actions through the normal chat send path", () => {
    expect(index).toContain('void sendMessage("Apply edit", null)');
    expect(index).toContain('void sendMessage("Create a redesigned copy instead", null)');
    expect(index).toContain('setInput("Revise the edit plan: ")');
    expect(index).toContain("onApplyFileEditPreview={handleApplyFileEditPreview}");
    expect(index).toContain("onReviseFileEditPreview={handleReviseFileEditPreview}");
    expect(index).toContain("onRedesignFileEditPreview={handleRedesignFileEditPreview}");
    expect(index).toContain("isLatest ? onApplyFileEditPreview : undefined");
  });
});

describe("Phase 9D — cancel file-edit preview wiring (mobile)", () => {
  const index = read("../../app/(home)/index.tsx");
  const extras = read("../../components/ora/MessageExtras.tsx");

  it("index has handleCancelFileEditPreview callback that sends the cancel message", () => {
    expect(index).toContain("handleCancelFileEditPreview");
    expect(index).toContain('void sendMessage("Never mind, cancel the edit", null)');
    expect(index).toContain("onCancelFileEditPreview={handleCancelFileEditPreview}");
    expect(index).toContain("isLatest ? onCancelFileEditPreview : undefined");
  });

  it("OraAssistantExtras and OraFileAgentPreviewIndicator accept onCancel", () => {
    expect(extras).toContain("onCancelFileEditPreview");
    expect(extras).toContain("onCancel?: () => void;");
    expect(extras).toContain("onCancel={onCancelFileEditPreview}");
    expect(extras).toContain("Never mind");
  });
});

describe("Phase 9F — mobile file card View+Download parity audit", () => {
  const extras = read("../../components/ora/MessageExtras.tsx");

  it("OraFileAgentPreviewIndicator renders 'Content being changed' section for contentChanges (Phase 9C mobile parity)", () => {
    expect(extras).toContain("Content being changed");
    expect(extras).toContain("preview.contentChanges && preview.contentChanges.length > 0");
    expect(extras).toContain("preview.contentChanges.map(");
    expect(extras).toContain("change.label");
    expect(extras).toContain("change.from");
    expect(extras).toContain("change.to");
  });

  it("contentChanges from-text renders with line-through (struck-out old text)", () => {
    expect(extras).toContain('textDecorationLine: "line-through"');
  });

  it("contentChanges to-text renders with accent color (highlighted new text)", () => {
    const contentChangesStart = extras.indexOf(
      "preview.contentChanges && preview.contentChanges.length > 0",
    );
    const contentChangesEnd = extras.indexOf(
      'preview.status === "needs_confirmation"',
      contentChangesStart,
    );
    const contentChangesBlock = extras.slice(contentChangesStart, contentChangesEnd);
    expect(contentChangesBlock).toContain("change.to");
    expect(contentChangesBlock).toContain("tone");
    expect(contentChangesBlock).toContain("backgroundColor");
  });

  it("previewTone returns green for applied, amber for failed_safe, gray for unchanged, blue for default", () => {
    const toneFn = extras.slice(
      extras.indexOf("function previewTone("),
      extras.indexOf("function OraFileAgentPreviewIndicator("),
    );
    expect(toneFn).toContain('"#10b981"');
    expect(toneFn).toContain('"#f59e0b"');
    expect(toneFn).toContain('"#94a3b8"');
    expect(toneFn).toContain('"#0ea5e9"');
  });

  it("OraFileAgentPreviewIndicator bullets include outputSections (website parity)", () => {
    const bulletStart = extras.indexOf("const bullets = [");
    const bulletEnd = extras.indexOf("].slice(0, 5)", bulletStart);
    const bulletBlock = extras.slice(bulletStart, bulletEnd);
    expect(bulletBlock).toContain("preview.outputSections");
    expect(bulletBlock).toContain("preview.detectedInputs");
    expect(bulletBlock).toContain("preview.plannedActions");
    expect(bulletBlock).toContain("preview.calculations");
    expect(bulletBlock).toContain("preview.charts");
  });

  it("tone color is applied to border and background of the indicator card", () => {
    const indicatorStart = extras.indexOf("function OraFileAgentPreviewIndicator(");
    const indicatorEnd = extras.indexOf("\nfunction ", indicatorStart + 1);
    const indicatorBody = extras.slice(indicatorStart, indicatorEnd);
    expect(indicatorBody).toContain('tone + "40"');
    expect(indicatorBody).toContain('tone + "0D"');
  });
});
