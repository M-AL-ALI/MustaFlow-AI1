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

describe("English and Arabic project tool discovery", () => {
  it.each([
    [
      "\u0645\u0639\u0627\u064a\u0646\u0629 \u0639\u0631\u0636 \u0627\u0644\u062a\u0637\u0628\u064a\u0642",
      "preview",
    ],
    ["\u062e\u0631\u064a\u0637\u0629 \u0627\u0644\u0635\u0641\u062d\u0627\u062a", "page-map"],
    ["\u062e\u0637\u0629 \u062a\u062e\u0637\u064a\u0637 \u0645\u0647\u0627\u0645", "plan"],
    [
      "\u0635\u0648\u0631 \u0627\u0644\u0635\u0648\u0631 \u0645\u0643\u062a\u0628\u0629 \u0627\u0644\u0635\u0648\u0631 \u0627\u0633\u062a\u0648\u062f\u064a\u0648 \u0627\u0644\u0635\u0648\u0631",
      "images",
    ],
    [
      "\u0645\u0644\u0641\u0627\u062a \u0643\u0648\u062f \u0634\u064a\u0641\u0631\u0629 \u0645\u062d\u0631\u0631 \u0627\u0644\u0645\u0644\u0641\u0627\u062a",
      "code",
    ],
    [
      "\u0648\u0635\u0641\u0627\u062a \u0642\u0648\u0627\u0644\u0628 \u0648\u062d\u062f\u0627\u062a",
      "recipes",
    ],
    [
      "\u0633\u064a\u0631 \u0627\u0644\u0639\u0645\u0644 \u062a\u062f\u0641\u0642\u0627\u062a \u0627\u0644\u0639\u0645\u0644 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0645\u0647\u0627\u0645",
      "workflows",
    ],
    [
      "\u0646\u0634\u0631 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0646\u0637\u0627\u0642\u0627\u062a \u0627\u0644\u062f\u0648\u0645\u064a\u0646",
      "publishing",
    ],
    [
      "\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0634\u0631\u0648\u0639",
      "manage",
    ],
    [
      "\u0637\u0631\u0641\u064a\u0629 \u0623\u0648\u0627\u0645\u0631 \u0633\u0637\u0631 \u0627\u0644\u0623\u0648\u0627\u0645\u0631 \u0634\u0644",
      "terminal",
    ],
    [
      "\u062a\u0635\u0645\u064a\u0645 \u0644\u0648\u062d\u0629 \u0627\u0644\u0631\u0633\u0645 \u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u0635\u0645\u064a\u0645",
      "canvas",
    ],
    ["\u0623\u0633\u0631\u0627\u0631", "secrets"],
    [
      "\u0625\u0639\u062f\u0627\u062f \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062a\u0647\u064a\u0626\u0629 \u0627\u0644\u0645\u0634\u0631\u0648\u0639",
      "tools-files",
    ],
    [
      "\u062a\u0643\u0627\u0645\u0644 \u062a\u0643\u0627\u0645\u0644\u0627\u062a \u0631\u0628\u0637 \u062e\u062f\u0645\u0627\u062a \u0627\u062a\u0635\u0627\u0644\u0627\u062a",
      "integrations",
    ],
    [
      "\u0641\u062d\u0648\u0635 \u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a \u0627\u062e\u062a\u0628\u0627\u0631 \u062a\u062d\u0642\u0642",
      "checks",
    ],
    [
      "\u0623\u0645\u0627\u0646 \u0623\u0645\u0646 \u062d\u0645\u0627\u064a\u0629 \u062b\u063a\u0631\u0627\u062a",
      "security",
    ],
    [
      "\u0645\u0639\u0631\u0641\u0629 \u0630\u0627\u0643\u0631\u0629 \u0633\u064a\u0627\u0642 \u0645\u062d\u0641\u0648\u0638",
      "knowledge",
    ],
    ["\u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a", "database"],
    [
      "\u062e\u0627\u062f\u0645 \u0627\u0644\u062e\u0627\u062f\u0645 \u0627\u0644\u0633\u064a\u0631\u0641\u0631 \u0627\u0633\u062a\u0636\u0627\u0641\u0629 \u0628\u064a\u0626\u0629 \u0627\u0644\u062a\u0634\u063a\u064a\u0644",
      "runtime",
    ],
    [
      "\u062c\u064a\u062a \u0625\u0635\u062f\u0627\u0631\u0627\u062a \u0645\u0633\u062a\u0648\u062f\u0639 \u0645\u0632\u0627\u0645\u0646\u0629",
      "git",
    ],
    [
      "\u0633\u062c\u0644\u0627\u062a \u0633\u062c\u0644 \u0645\u062e\u0631\u062c\u0627\u062a \u0648\u062d\u062f\u0629 \u0627\u0644\u062a\u062d\u0643\u0645",
      "logs",
    ],
    [
      "\u0645\u0648\u0627\u0631\u062f \u062a\u0648\u062b\u064a\u0642 \u062f\u0644\u064a\u0644",
      "resources",
    ],
    [
      "\u062a\u062d\u0644\u064a\u0644\u0627\u062a \u0625\u062d\u0635\u0627\u0626\u064a\u0627\u062a \u0632\u064a\u0627\u0631\u0627\u062a",
      "analytics",
    ],
    [
      "\u0635\u062d\u0629 \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062c\u0648\u062f\u0629",
      "health",
    ],
    [
      "\u062a\u0639\u0644\u064a\u0642\u0627\u062a \u0645\u0644\u0627\u062d\u0638\u0627\u062a",
      "comments",
    ],
    [
      "\u0633\u062c\u0644 \u0627\u0644\u0646\u0634\u0627\u0637 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0646\u0634\u0627\u0637",
      "activity-log",
    ],
    [
      "\u0646\u0642\u0627\u0637 \u0627\u0644\u062d\u0641\u0638 \u062d\u0641\u0638 \u0627\u0633\u062a\u0639\u0627\u062f\u0629 \u0631\u062c\u0648\u0639",
      "checkpoints",
    ],
  ])("finds %s without changing its registered destination", (query, id) => {
    const registered = WORKSPACE_TOOLS.find((tool) => tool.id === id);
    expect(registered).toBeDefined();
    expect(findProjectTools(query, true)).toContain(registered);
  });
  it.each([
    ["tables SQL", "database"],
    ["  command    shell  ", "terminal"],
    ["source code", "code"],
    ["\u0628\u064a\u0627\u0646\u0627\u062a database", "database"],
    [
      "\u0642\u064e\u0627\u0639\u0650\u062f\u064e\u0629 \u0627\u0644\u0628\u064e\u064a\u064e\u0627\u0646\u064e\u0627\u062a",
      "database",
    ],
    [
      "\u0642\u0640\u0640\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a",
      "database",
    ],
    ["\u0627\u0633\u0631\u0627\u0631", "secrets"],
    ["\ufe8d\ufedf\ufe92\ufef4\ufe8e\ufee7\ufe8e\ufe95", "database"],
    ["\uff33\uff28\uff25\uff2c\uff2c", "terminal"],
  ])("normalizes %s and matches all search terms", (query, id) => {
    expect(findProjectTools(query, false).some((tool) => tool.id === id)).toBe(true);
  });
  it("requires every word rather than returning unrelated tools", () => {
    expect(findProjectTools("database nonexistentkeyword", true)).toEqual([]);
    expect(
      findProjectTools(
        "\u0642\u0627\u0639\u062f\u0629 \u0643\u0644\u0645\u0629\u063a\u064a\u0631\u0645\u0648\u062c\u0648\u062f\u0629",
        true,
      ),
    ).toEqual([]);
  });
  it("preserves published-only availability for Arabic and mixed queries", () => {
    expect(findProjectTools("\u062a\u062d\u0644\u064a\u0644\u0627\u062a", false)).toEqual([]);
    expect(findProjectTools("analytics \u062a\u062d\u0644\u064a\u0644\u0627\u062a", false)).toEqual(
      [],
    );
    expect(
      findProjectTools("\u062a\u062d\u0644\u064a\u0644\u0627\u062a", true).map((tool) => tool.id),
    ).toEqual(["analytics"]);
  });
});

describe("project tool relevance", () => {
  it.each(WORKSPACE_TOOLS)("ranks exact displayed name $name first", (tool) => {
    expect(findProjectTools(tool.name, true)[0]).toBe(tool);
  });
  it.each(WORKSPACE_TOOLS)("ranks exact registered ID $id first", (tool) => {
    expect(findProjectTools(tool.id, true)[0]).toBe(tool);
  });
  it.each(["server", "  SERVER  ", "serv"])("places %s before a descriptive alias", (query) => {
    const results = findProjectTools(query, false);
    expect(results[0]?.id).toBe("runtime");
    expect(results.some((tool) => tool.id === "logs")).toBe(true);
  });
  it("does not reorder the empty or whitespace-only catalog", () => {
    expect(findProjectTools("", true)).toEqual(WORKSPACE_TOOLS);
    expect(findProjectTools("  ", true)).toEqual(WORKSPACE_TOOLS);
  });
});
