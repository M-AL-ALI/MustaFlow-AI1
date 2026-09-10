import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOLS } from "@workspace/nabuflow-workspace-tools";
import { findProjectTools, projectToolSearchText } from "./project-tool-search";

describe("project tool search", () => {
  it.each([
    ["shell", "terminal", "terminal"],
    ["logs", "logs", "logs"],
    ["runtime", "runtime", "runtime"],
    ["checkpoints", "checkpoints", "checkpoints"],
    ["memory", "knowledge", "knowledge"],
    ["image studio", "images", "images"],
    ["sitemap", "page-map", "page-map"],
    ["deployment", "publishing", "publishing"],
    ["connectors", "integrations", "integrations"],
  ])("resolves %s to the existing %s tool", (query, id, tabId) => {
    expect(findProjectTools(query, false)).toContainEqual(
      expect.objectContaining({ id, open: expect.objectContaining({ tabId }) }),
    );
  });
  it("keeps published-only tools out of search and the unfiltered list", () => {
    expect(findProjectTools("analytics", false)).toEqual([]);
    expect(findProjectTools("", false)).toHaveLength(26);
    expect(findProjectTools("analytics", true).map((tool) => tool.id)).toEqual(["analytics"]);
    expect(findProjectTools("", true)).toHaveLength(27);
  });
  it("keeps name, description and category searches and trims surrounding spaces", () => {
    expect(findProjectTools("  SHELL  ", false).some((tool) => tool.id === "terminal")).toBe(true);
    expect(findProjectTools("Protect", false).every((tool) => tool.category === "Protect")).toBe(
      true,
    );
    expect(findProjectTools("xyz-nonexistent", true)).toEqual([]);
    for (const tool of WORKSPACE_TOOLS) {
      expect(projectToolSearchText(tool)).toContain(tool.name);
      expect(projectToolSearchText(tool)).toContain(tool.description);
    }
  });
  it("returns original registry objects without inventing duplicate destinations", () => {
    const results = findProjectTools("", true);
    expect(new Set(results.map((tool) => tool.id)).size).toBe(results.length);
    for (const tool of results) expect(WORKSPACE_TOOLS).toContain(tool);
  });
});
