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

/** Primary tools plus one current destination, using the registry's availability rules. */
export function getEditorWorkspaceTabs({
  activeTab,
  subview,
  isPublished,
}: {
  activeTab: string;
  subview?: string;
  isPublished: boolean;
}): EditorWorkspaceTab[] {
  const available = WORKSPACE_TOOLS.filter((tool) => tool.availability === "always" || isPublished);
  const primary = available.filter((tool) => tool.placement === "primary");
  const matches = available.filter((tool) => tool.open.tabId === activeTab);
  const selected =
    matches.find((tool) => (tool.open as WorkspaceToolOpen).subview === subview) ??
    matches.find((tool) => tool.placement !== "launcher") ??
    matches[0];
  const destinations = new Set<string>();
  return (selected ? [...primary, selected] : primary)
    .filter((tool) => {
      if (destinations.has(tool.open.tabId)) return false;
      destinations.add(tool.open.tabId);
      return true;
    })
    .map((tool) => ({
      toolId: tool.id,
      label: tool.name,
      value: tool.open.tabId,
      open: tool.open,
    }));
}
