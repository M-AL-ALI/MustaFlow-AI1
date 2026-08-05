import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) => readFileSync(resolve(here, relativePath), "utf8");

const hookSource = read("../../../hooks/use-ora-chat.ts");
const realtimeVoiceSource = read("../../../hooks/use-ora-realtime-voice.ts");
const whisperRecorderSource = read("../../../hooks/use-whisper-recorder.ts");
const panelSource = read("../../ora-panel.tsx");
const bubbleSource = read("../../ora-bubble.tsx");
const voicePanelSource = read("../ora-voice-mode-button.tsx");
const voiceTipSource = read("../ora-voice-tip.tsx");

describe("Phase 9D — cancel file-edit preview wiring (website)", () => {
  it("panel has handleCancelFileEditPreview callback and sends the cancel message", () => {
    expect(panelSource).toContain("handleCancelFileEditPreview");
    expect(panelSource).toContain('void sendMessage("Never mind, cancel the edit")');
    expect(panelSource).toMatch(
      /onCancel=\{[\s\S]*isLatestAssistant \? handleCancelFileEditPreview/,
    );
  });

  it("bubble has handleCancelFileEditPreview callback and sends the cancel message", () => {
    expect(bubbleSource).toContain("handleCancelFileEditPreview");
    expect(bubbleSource).toContain('void sendMessage("Never mind, cancel the edit")');
    expect(bubbleSource).toMatch(
      /onCancel=\{[\s\S]*isLatestAssistant \? handleCancelFileEditPreview/,
    );
  });
});

describe("Ora chat UX response wiring", () => {
  it("keeps the public chat response fields in the hook contract", () => {
    [
      "suggestions?: string[];",
      "fileName?: string;",
      "fileData?: string;",
      "mimeType?: string;",
      "imageUrl?: string;",
      "imageId?: number;",
      "imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };",
      'memorySaveCandidateConfidence?: "high" | "low";',
      "memorySaveCandidateSensitive?: boolean;",
      "memoriesUsed?: OraMemoryUsed[];",
      "fileAgentPreview?: OraFileAgentPreview;",
      "conversationSummary?: string;",
    ].forEach((field) => {
      expect(hookSource).toContain(field);
    });
  });

  it("maps backend response payloads onto assistant messages", () => {
    expect(hookSource).toMatch(/suggestions:\s*d\.suggestions\s*\?\?\s*\[\]/);
    expect(hookSource).toContain("...(d.imageUrl ? { imageUrl: d.imageUrl } : {})");
    expect(hookSource).toContain("...(d.imageId != null ? { imageId: d.imageId } : {})");
    expect(hookSource).toContain("...(d.imageMeta ? { imageMeta: d.imageMeta } : {})");
    expect(hookSource).toMatch(
      /d\.memoriesUsed\s*&&\s*d\.memoriesUsed\.length\s*>\s*0[\s\S]*memoriesUsed:\s*d\.memoriesUsed/,
    );
    expect(hookSource).toMatch(
      /d\.memorySaveCandidate[\s\S]*memorySaveCandidate:\s*d\.memorySaveCandidate[\s\S]*memorySaveCandidateConfidence/,
    );
    expect(hookSource).toMatch(
      /d\.fileName\s*&&\s*d\.fileData\s*&&\s*d\.mimeType[\s\S]*generatedFile:[\s\S]*fileName:\s*d\.fileName[\s\S]*fileData:\s*d\.fileData[\s\S]*mimeType:\s*d\.mimeType/,
    );
    expect(hookSource).toContain(
      "...(d.fileAgentPreview ? { fileAgentPreview: d.fileAgentPreview } : {})",
    );
    expect(hookSource).toContain(
      "...(m.fileAgentPreview ? { fileAgentPreview: m.fileAgentPreview } : {})",
    );
  });

  it("keeps image profile metadata when inline edits create a new image", () => {
    expect(hookSource).toMatch(
      /const sourceImageMeta = messagesRef\.current\.find\([\s\S]*m\.imageId === sourceImageId[\s\S]*\)\?\.imageMeta/,
    );
    expect(hookSource).toContain("...(sourceImageMeta ? { imageMeta: sourceImageMeta } : {})");
  });

  it("renders generated media, files, suggestions, and memory signals in the main Ora panel", () => {
    expect(panelSource).toContain(
      'import { OraMemorySaveChip } from "@/components/ora/ora-memory-save-chip";',
    );
    expect(panelSource).toContain(
      'import { OraMemoriesUsedChip } from "@/components/ora/ora-memories-used-chip";',
    );
    expect(panelSource).toContain(
      'import { OraDocumentMemoryChip } from "@/components/ora/ora-document-memory-chip";',
    );
    expect(panelSource).toContain(
      'import { OraFileAgentPreviewCard } from "@/components/ora/ora-file-agent-preview-card";',
    );

    expect(panelSource).toMatch(/msg\.imageUrl\s*&&[\s\S]*<img[\s\S]*src=\{msg\.imageUrl\}/);
    expect(panelSource).toContain("formatOraImageMeta(msg.imageMeta)");
    expect(panelSource).toMatch(
      /msg\.imageId\s*!=\s*null\s*&&\s*isSignedIn[\s\S]*submitImageEdit\(msg\.imageId!\)/,
    );
    expect(panelSource).toContain("function GeneratedFileCard(");
    expect(panelSource).toContain('file.format === "pdf" ? "application/octet-stream"');
    expect(panelSource).toContain("View or download");
    expect(panelSource).toContain("viewOraFile(file)");
    expect(panelSource).toContain("downloadOraFile(file)");
    expect(panelSource).toContain("handleReviseGeneratedFile");
    expect(panelSource).toContain(
      'Revise the ${file.format.toUpperCase()} file "${file.fileName}": ',
    );
    expect(panelSource).toContain("setSelectedFormat(file.format)");
    expect(panelSource).toContain("onRevise={handleReviseGeneratedFile}");
    expect(panelSource).toMatch(/msg\.generatedFile\s*&&\s*\([\s\S]*<GeneratedFileCard/);
    expect(panelSource).toMatch(/<OraFileAgentPreviewCard[\s\S]*preview=\{msg\.fileAgentPreview\}/);
    expect(panelSource).toContain("handleApplyFileEditPreview");
    expect(panelSource).toContain('void sendMessage("Apply edit")');
    expect(panelSource).toContain('void sendMessage("Create a redesigned copy instead")');
    expect(panelSource).toContain('const revisionPrompt = "Revise the edit plan: ";');
    expect(panelSource).toMatch(/onApply=\{[\s\S]*isLatestAssistant \? handleApplyFileEditPreview/);
    expect(panelSource).toMatch(
      /onRedesign=\{[\s\S]*isLatestAssistant \? handleRedesignFileEditPreview/,
    );
    expect(panelSource).toMatch(
      /msg\.memorySaveCandidate\s*\|\|\s*msg\.memorySaved[\s\S]*<OraMemorySaveChip[\s\S]*onSave=\{\(\) => handleSaveMemory/,
    );
    expect(panelSource).toMatch(
      /Array\.isArray\(msg\.memoriesUsed\)[\s\S]*msg\.memoriesUsed\.length\s*>\s*0[\s\S]*<OraMemoriesUsedChip/,
    );
    expect(panelSource).toMatch(/msg\.documentMemory[\s\S]*<OraDocumentMemoryChip/);
    expect(panelSource).toMatch(
      /const showSuggestions =[\s\S]*Array\.isArray\(msg\.suggestions\)[\s\S]*msg\.suggestions\.length > 0/,
    );
    expect(panelSource).toMatch(/showSuggestions &&[\s\S]*msg\.suggestions!\.map/);
  });

  it("auto-saves only high-confidence non-sensitive memory candidates", () => {
    const autoSaveStart = panelSource.indexOf("Save-by-default auto-save");
    expect(autoSaveStart).toBeGreaterThan(-1);
    const autoSaveBody = panelSource.slice(autoSaveStart, autoSaveStart + 1400);

    expect(autoSaveBody).toContain('msg.memorySaveCandidateConfidence === "high"');
    expect(autoSaveBody).toContain("msg.memorySaveCandidateSensitive === true");
    expect(autoSaveBody).toContain("highConfidence");
    expect(autoSaveBody).toContain("!sensitive");
    expect(panelSource).not.toContain("getAskBeforeSensitive");
  });

  it("keeps the public home bubble usable for generated images, files, and suggestions", () => {
    expect(bubbleSource).toMatch(/msg\.imageUrl\s*&&[\s\S]*<img[\s\S]*src=\{msg\.imageUrl\}/);
    expect(bubbleSource).toContain("formatOraImageMeta(msg.imageMeta)");
    expect(bubbleSource).toContain("function GeneratedFileCard(");
    expect(bubbleSource).toContain('file.format === "pdf" ? "application/octet-stream"');
    expect(bubbleSource).toContain("View or download");
    expect(bubbleSource).toContain("viewOraFile(file)");
    expect(bubbleSource).toContain("downloadOraFile(file)");
    expect(bubbleSource).toContain("handleReviseGeneratedFile");
    expect(bubbleSource).toContain(
      'Revise the ${file.format.toUpperCase()} file "${file.fileName}": ',
    );
    expect(bubbleSource).toContain("setSelectedFormat(file.format)");
    expect(bubbleSource).toContain("onRevise={handleReviseGeneratedFile}");
    expect(bubbleSource).toMatch(/msg\.generatedFile\s*&&\s*\([\s\S]*<GeneratedFileCard/);
    expect(bubbleSource).toMatch(
      /<OraFileAgentPreviewCard[\s\S]*preview=\{msg\.fileAgentPreview\}/,
    );
    expect(bubbleSource).toContain("handleApplyFileEditPreview");
    expect(bubbleSource).toContain('void sendMessage("Apply edit")');
    expect(bubbleSource).toContain('void sendMessage("Create a redesigned copy instead")');
    expect(bubbleSource).toContain('const revisionPrompt = "Revise the edit plan: ";');
    expect(bubbleSource).toMatch(
      /onApply=\{[\s\S]*isLatestAssistant \? handleApplyFileEditPreview/,
    );
    expect(bubbleSource).toMatch(
      /onRedesign=\{[\s\S]*isLatestAssistant \? handleRedesignFileEditPreview/,
    );
    expect(bubbleSource).toMatch(
      /const showSuggestions =[\s\S]*Array\.isArray\(msg\.suggestions\)[\s\S]*msg\.suggestions\.length > 0/,
    );
    expect(bubbleSource).toMatch(/showSuggestions &&[\s\S]*msg\.suggestions!\.map/);
  });
});

describe("Ora Item 5 quick wins (website)", () => {
  it("keeps edited-image rendering visibly staged until the asset is loaded", () => {
    expect(hookSource).toContain('setStreamStatus("Rendering the edited image...")');
    expect(hookSource).toContain('setStreamStatus("Loading the edited image...")');
    expect(hookSource).toMatch(/finally[\s\S]*setStreamStatus\(null\)/);
  });

  it("keeps generated images from being hidden behind the composer", () => {
    expect(panelSource).toContain('"px-4 pt-4 pb-28"');
    expect(panelSource).toContain('"max-w-3xl mx-auto w-full space-y-6 pt-6 pb-32"');
    expect(panelSource).toContain("requestAnimationFrame(jumpToLatest)");
    expect(bubbleSource).toContain('"px-4 pt-4 pb-28 space-y-5"');
    expect(bubbleSource).toContain("requestAnimationFrame(jumpToLatest)");
  });

  it("confirms generated-file open/download actions and surfaces failed asset fetches", () => {
    for (const source of [panelSource, bubbleSource]) {
      expect(source).toContain("const showFileNotice =");
      expect(source).toContain("throw new Error(`Download failed (${res.status}).`)");
      expect(source).toContain("throw new Error(`Could not open file (${res.status}).`)");
      expect(source).toContain("showFileNotice(`Opened ${file.fileName}.`)");
      expect(source).toContain("showFileNotice(`Download started: ${file.fileName}`)");
      expect(source).toContain("fileNotice &&");
    }
  });

  it("renders no-microphone as a stable disabled voice state on both web shells", () => {
    expect(whisperRecorderSource).toContain("isMicrophoneUnavailable");
    expect(whisperRecorderSource).toContain(
      "No microphone found on this device. Connect or enable a microphone, then tap Retry.",
    );
    expect(whisperRecorderSource).toContain("!permissionDenied && !microphoneUnavailable");
    expect(realtimeVoiceSource).toContain(
      "No microphone found. Connect or enable a microphone, then try again.",
    );

    for (const source of [panelSource, bubbleSource]) {
      expect(source).toContain("whisperConv.isMicrophoneUnavailable");
      expect(source).toContain(
        "whisperMicrophoneUnavailable={whisperConv.isMicrophoneUnavailable}",
      );
    }

    expect(voicePanelSource).toContain("whisperMicrophoneUnavailable");
    expect(voicePanelSource).toContain('"No microphone found"');
    expect(voicePanelSource).toContain(
      "isNoMic ? false : isListening || isSpeaking || whisperRecording",
    );
    expect(voicePanelSource).toContain("No mic");
  });
});

describe("Ora Item 6 mobile-width layout polish (website)", () => {
  it("keeps the first-run voice tip collapsed until the user expands it", () => {
    expect(voiceTipSource).toContain("const [expanded, setExpanded] = useState(false)");
    expect(voiceTipSource).toContain("Voice tools available");
    expect(voiceTipSource).toContain("aria-expanded={expanded}");
    expect(voiceTipSource).toContain("setExpanded((current) => !current)");
    expect(voiceTipSource).toMatch(/expanded \? \([\s\S]*buildTipText/);
  });
});
