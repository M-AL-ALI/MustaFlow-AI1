import {
  WORKSPACE_TOOLS,
  type WorkspaceToolId,
  type WorkspaceToolOpen,
} from "@workspace/nabuflow-workspace-tools";

export interface EditorWorkspaceTab {
  toolId: WorkspaceToolId;
  label: string;
  value: string;
  open: WorkspaceToolOpen;
}
export const MAX_OPEN_SECONDARY_TOOLS = 4;

/** Resolve only registered destinations. Launcher subviews retain their actual destination. */
export function getEditorWorkspaceTabs({
  activeTab,
  subview,
  isPublished,
  openTabs = [],
}: {
  activeTab: string;
  subview?: string;
  isPublished: boolean;
  openTabs?: readonly EditorWorkspaceTab[];
}): EditorWorkspaceTab[] {
  const available = WORKSPACE_TOOLS.filter((tool) => tool.availability === "always" || isPublished);
  const primary = available.filter((tool) => tool.placement === "primary");
  const resolve = (tabId: string, view?: string) => {
    const matches = available.filter((tool) => tool.open.tabId === tabId);
    return (
      matches.find((tool) => (tool.open as WorkspaceToolOpen).subview === view) ??
      matches.find((tool) => tool.placement !== "launcher") ??
      matches[0]
    );
  };
  const selected = resolve(activeTab, subview);
  const destinations = new Map<string, (typeof available)[number]>();
  for (const tool of primary) destinations.set(tool.open.tabId, tool);
  for (const tab of openTabs) {
    const tool = resolve(tab.value, tab.open.subview);
    if (tool) destinations.set(tool.open.tabId, tool);
  }
  if (selected) destinations.set(selected.open.tabId, selected);
  // Bound visible navigation, never the underlying tools or their data.
  let secondaryCount = [...destinations.values()].filter(
    (tool) => tool.placement !== "primary",
  ).length;
  for (const [id, tool] of destinations) {
    if (secondaryCount <= MAX_OPEN_SECONDARY_TOOLS) break;
    if (tool.placement !== "primary" && id !== selected?.open.tabId) {
      destinations.delete(id);
      secondaryCount -= 1;
    }
  }
  return [...destinations.values()].map((tool) => ({
    toolId: tool.id,
    label: tool.name,
    value: tool.open.tabId,
    open: tool.open,
  }));
}
