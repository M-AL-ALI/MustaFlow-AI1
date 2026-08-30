import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/pages/projects/components/preview-tab.tsx"),
  "utf8",
);

describe("visual edit session UI contract", () => {
  it("replays edit mode even when the bridge ready message arrived before the parent listener", () => {
    expect(source).toContain("if (win) {");
    expect(source).not.toContain("if (win && veReadyRef.current)");
    expect(source).toContain(
      'win.postMessage({ __mustaflow_edit: true, type: "setMode", on: editMode }, "*")',
    );
    expect(source).toContain('if (data.type === "ready")');
  });

  it("opens one server session and binds every source change to it", () => {
    expect(source).toContain("/visual-edit/sessions`");
    expect(source).toContain("sessionId: veSessionId");
    expect(source).toContain("Visual editing is still starting");
  });

  it("offers immediate undo and closes into one restorable version", () => {
    expect(source).toContain("/visual-edit/sessions/${veSessionId}/undo");
    expect(source).toContain("/visual-edit/sessions/${closingSessionId}/close");
    expect(source).toContain("Saved as restorable version #");
  });

  it("keeps unsafe source mapping on the conversational refusal path", () => {
    expect(source).toContain("json.suggestedPrompt");
    expect(source).toContain("setEditMode(false)");
  });

  it("makes breakpoint, reorder, and reference comparison explicit in the preview", () => {
    expect(source).toContain("breakpoint: device");
    expect(source).toContain('kind: "reorder"');
    expect(source).toContain("direction: payload.direction");
    expect(source).toContain('applyVisualEdit({ kind: "reorder", direction: "up" })');
    expect(source).toContain('applyVisualEdit({ kind: "reorder", direction: "down" })');
    expect(source).toContain("Add reference overlay");
    expect(source).toContain('aria-label="Reference overlay opacity"');
    expect(source.match(/\{renderReferenceOverlay\(\)\}/gu)).toHaveLength(3);
    expect(source).toContain('aria-label="Drag selected element to resize"');
    expect(source).toContain('aria-label="Drag selected element to reorder"');
    expect(source).toContain("Release to save this size");
    expect(source).toContain("veSelections.length > 1");
    expect(source).toContain(
      "elements selected · changes to style, spacing, visibility, and delete apply to all",
    );
    expect(source).toContain("for (const selection of veSelections)");
    expect(source).toContain("Crop to frame");
    expect(source).toContain("Remove background");
    expect(source).toContain("Generate a replacement for the selected image");
    expect(source).toContain('property: "object-fit"');
  });
});
