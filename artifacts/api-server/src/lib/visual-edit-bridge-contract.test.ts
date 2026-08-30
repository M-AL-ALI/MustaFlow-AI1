import { describe, expect, it } from "vitest";
import { VISUAL_EDIT_SCRIPT } from "./visualEditScript";

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
});
