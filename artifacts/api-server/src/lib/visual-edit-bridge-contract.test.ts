import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VISUAL_EDIT_SCRIPT } from "./visualEditScript";

const root = resolve(import.meta.dirname, "..");
const previewRenderer = readFileSync(
  resolve(import.meta.dirname, "project-files-preview.ts"),
  "utf8",
);
const filesRoute = readFileSync(resolve(root, "routes/files.ts"), "utf8");
const livePreviewProxy = readFileSync(resolve(import.meta.dirname, "livePreviewProxy.ts"), "utf8");

describe("visual edit bridge selection contract", () => {
  it("supports bounded shift-click multi-selection and clears every highlight on exit", () => {
    expect(VISUAL_EDIT_SCRIPT).toContain("var additive = !!e.shiftKey");
    expect(VISUAL_EDIT_SCRIPT).toContain("selected: el.classList.contains");
    expect(VISUAL_EDIT_SCRIPT).toContain('document.querySelectorAll(".__mfm_sel")');
    expect(VISUAL_EDIT_SCRIPT).not.toContain('document.querySelector(".__mfm_sel")');
    expect(VISUAL_EDIT_SCRIPT).toContain("TRUSTED_PARENT_ORIGINS");
    expect(VISUAL_EDIT_SCRIPT).toContain("ev.source === window.parent");
    expect(VISUAL_EDIT_SCRIPT).toContain('type:"modeApplied"');
    expect(VISUAL_EDIT_SCRIPT).not.toContain('postMessage(payload, "*")');
  });

  it("binds bridge injection to authenticated preview context, not publication state", () => {
    expect(previewRenderer).toContain("visualEditEnabled: boolean");
    expect(previewRenderer).toContain("options.visualEditEnabled ?");
    expect(previewRenderer).not.toContain('projectStatus !== "published"');
    expect(filesRoute).toContain("visualEditEnabled: true");
  });

  it("keeps the bridge out of public static fallback and runtime error responses", () => {
    expect(
      livePreviewProxy.match(/visualEditEnabled: options\?\.publicRequestUrl === undefined/gu),
    ).toHaveLength(1);
    expect(livePreviewProxy).not.toContain(
      "visualEditEnabled: expressReq.mustaFlowPublicPreview === undefined",
    );
    const proxyErrorStart = livePreviewProxy.indexOf("error: (err, req, target)");
    const proxyErrorEnd = livePreviewProxy.indexOf("\n    },\n  },\n});", proxyErrorStart);
    expect(proxyErrorStart).toBeGreaterThan(-1);
    expect(proxyErrorEnd).toBeGreaterThan(proxyErrorStart);
    expect(livePreviewProxy.slice(proxyErrorStart, proxyErrorEnd)).not.toContain(
      "serveProjectFilesPreview",
    );
  });
});
