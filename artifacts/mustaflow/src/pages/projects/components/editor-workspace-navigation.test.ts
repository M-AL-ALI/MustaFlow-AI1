import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOLS, type WorkspaceToolOpen } from "@workspace/nabuflow-workspace-tools";
import { getEditorWorkspaceTabs } from "./editor-workspace-navigation";

describe("editor registry navigation", () => {
  it("adds Database as the selected contextual destination", () => {
    const tabs = getEditorWorkspaceTabs({ activeTab: "database", isPublished: false });
    expect(tabs.map((tab) => tab.label)).toEqual(["Preview", "Page map", "Plan", "Database"]);
    expect(tabs.at(-1)?.open).toEqual({ kind: "workspace-tab", tabId: "database" });
  });

  it.each(["preview", "page-map", "plan"])(
    "does not duplicate the primary destination %s",
    (activeTab) => {
      const tabs = getEditorWorkspaceTabs({ activeTab, isPublished: false });
      expect(tabs.map((tab) => tab.value)).toEqual(["preview", "page-map", "plan"]);
    },
  );

  it("replaces the contextual tab when another tool is selected", () => {
    const tabs = getEditorWorkspaceTabs({ activeTab: "terminal", isPublished: false });
    expect(tabs.map((tab) => tab.value)).toEqual(["preview", "page-map", "plan", "terminal"]);
    expect(tabs.some((tab) => tab.value === "database")).toBe(false);
  });

  it("preserves a Workflows launcher subview without duplicating Project setup", () => {
    const tabs = getEditorWorkspaceTabs({
      activeTab: "tools-files",
      subview: "shell",
      isPublished: false,
    });
    expect(tabs.filter((tab) => tab.value === "tools-files")).toHaveLength(1);
    expect(tabs.at(-1)).toMatchObject({
      toolId: "workflows",
      label: "Workflows",
      open: { kind: "workspace-tab", tabId: "tools-files", subview: "shell" },
    });
    expect(
      getEditorWorkspaceTabs({ activeTab: "tools-files", isPublished: false }).at(-1),
    ).toMatchObject({
      toolId: "tools-files",
      label: "Project setup",
      open: { subview: "files" },
    });
  });

  it("retains published-only availability", () => {
    expect(
      getEditorWorkspaceTabs({ activeTab: "analytics", isPublished: false }).some(
        (tab) => tab.value === "analytics",
      ),
    ).toBe(false);
    expect(
      getEditorWorkspaceTabs({ activeTab: "analytics", isPublished: true }).at(-1)?.label,
    ).toBe("Analytics");
  });

  it("does not invent a tab for an unknown destination", () => {
    expect(
      getEditorWorkspaceTabs({ activeTab: "not-a-tool", isPublished: true }).map(
        (tab) => tab.value,
      ),
    ).toEqual(["preview", "page-map", "plan"]);
  });

  it.each(WORKSPACE_TOOLS)("retains the registered destination and subview for $name", (tool) => {
    const open: WorkspaceToolOpen = tool.open;
    const tabs = getEditorWorkspaceTabs({
      activeTab: open.tabId,
      subview: open.subview,
      isPublished: true,
    });
    expect(tabs.find((tab) => tab.value === open.tabId)).toMatchObject({
      toolId: tool.id,
      label: tool.name,
      open: tool.open,
    });
    expect(new Set(tabs.map((tab) => tab.value)).size).toBe(tabs.length);
  });
});
