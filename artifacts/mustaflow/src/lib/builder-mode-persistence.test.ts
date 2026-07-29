import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  builderDeepReasoningStorageKey,
  loadBuilderDeepReasoning,
  saveBuilderDeepReasoning,
} from "./builder-mode-persistence";

describe("builder mode persistence", () => {
  beforeEach(() => localStorage.clear());

  it("keeps Eco as the fresh default and persists Deep per project", () => {
    expect(loadBuilderDeepReasoning(45, "eco")).toBe(false);

    expect(saveBuilderDeepReasoning(45, "eco", true)).toBe(true);
    expect(localStorage.getItem(builderDeepReasoningStorageKey(45))).toBe("1");
    expect(loadBuilderDeepReasoning(45, "eco")).toBe(true);
    expect(loadBuilderDeepReasoning(46, "eco")).toBe(false);
  });

  it("force-disables and persists Deep off in Lite", () => {
    saveBuilderDeepReasoning(45, "eco", true);

    expect(saveBuilderDeepReasoning(45, "lite", true)).toBe(false);
    expect(localStorage.getItem(builderDeepReasoningStorageKey(45))).toBe("0");
    expect(loadBuilderDeepReasoning(45, "lite")).toBe(false);
  });

  it("persists mode immediately through the existing project update store", () => {
    const page = readFileSync(resolve(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");

    expect(page).toContain("const persistAgentModeSelection = useCallback");
    expect(page).toContain("data: { agentMode: mode }");
    expect(page).toContain("onAgentModeChange={persistAgentModeSelection}");
    expect(page).toContain("onDeepReasoningChange={persistDeepReasoningSelection}");
  });
});
