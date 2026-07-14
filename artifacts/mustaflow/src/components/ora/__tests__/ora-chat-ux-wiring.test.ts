import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) => readFileSync(resolve(here, relativePath), "utf8");

const hookSource = read("../../../hooks/use-ora-chat.ts");
const panelSource = read("../../ora-panel.tsx");
const bubbleSource = read("../../ora-bubble.tsx");

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

    expect(panelSource).toMatch(/msg\.imageUrl\s*&&[\s\S]*<img[\s\S]*src=\{msg\.imageUrl\}/);
    expect(panelSource).toContain("formatOraImageMeta(msg.imageMeta)");
    expect(panelSource).toMatch(
      /msg\.imageId\s*!=\s*null\s*&&\s*isSignedIn[\s\S]*submitImageEdit\(msg\.imageId!\)/,
    );
    expect(panelSource).toMatch(
      /msg\.generatedFile\s*&&[\s\S]*msg\.generatedFile\.fileData\s*\?[\s\S]*downloadOraFile\(msg\.generatedFile!\)[\s\S]*Regenerate to download/,
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

  it("keeps the public home bubble usable for generated images, files, and suggestions", () => {
    expect(bubbleSource).toMatch(/msg\.imageUrl\s*&&[\s\S]*<img[\s\S]*src=\{msg\.imageUrl\}/);
    expect(bubbleSource).toContain("formatOraImageMeta(msg.imageMeta)");
    expect(bubbleSource).toMatch(
      /msg\.generatedFile\s*&&[\s\S]*msg\.generatedFile\.fileData\s*\?[\s\S]*downloadOraFile\(msg\.generatedFile!\)[\s\S]*Regenerate to download/,
    );
    expect(bubbleSource).toMatch(
      /const showSuggestions =[\s\S]*Array\.isArray\(msg\.suggestions\)[\s\S]*msg\.suggestions\.length > 0/,
    );
    expect(bubbleSource).toMatch(/showSuggestions &&[\s\S]*msg\.suggestions!\.map/);
  });
});
