import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_CATEGORIES, WORKSPACE_TOOLS } from "@workspace/nabuflow-workspace-tools";

describe("workspace tool registry", () => {
  it("covers every concrete workspace tab rendered by the real project page", () => {
    const pageSource = readFileSync(resolve(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");
    const renderedTabIds = new Set(
      [...pageSource.matchAll(/activeTab === ["']([^"']+)["']/g)].map((match) => match[1]),
    );
    const registeredTabIds = new Set(WORKSPACE_TOOLS.map((tool) => tool.open.tabId));

    expect([...renderedTabIds].filter((id) => !registeredTabIds.has(id))).toEqual([]);
    expect([...registeredTabIds].filter((id) => !renderedTabIds.has(id))).toEqual([]);
  });

  it("has unique ids and open destinations with complete plain-language metadata", () => {
    expect(new Set(WORKSPACE_TOOLS.map((tool) => tool.id)).size).toBe(WORKSPACE_TOOLS.length);
    const openDestinations = WORKSPACE_TOOLS.map(
      (tool) => `${tool.open.tabId}:${"subview" in tool.open ? tool.open.subview : ""}`,
    );
    expect(new Set(openDestinations).size).toBe(WORKSPACE_TOOLS.length);
    for (const tool of WORKSPACE_TOOLS) {
      expect(WORKSPACE_TOOL_CATEGORIES).toContain(tool.category);
      expect(tool.name.length).toBeGreaterThan(1);
      expect(tool.description.endsWith(".")).toBe(true);
    }
  });

  it("routes GitHub through Tools instead of the standalone advanced strip", () => {
    const pageSource = readFileSync(resolve(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");
    expect(pageSource).toContain('aria-label="Open project tools"');
    expect(pageSource).toContain('tab.value !== "git"');
  });
});
