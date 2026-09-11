import { useEffect, useRef, useState } from "react";
import { MessageSquare, Plus, X } from "lucide-react";
import { WORKSPACE_TOOLS, type WorkspaceToolOpen } from "@workspace/nabuflow-workspace-tools";
import { cn } from "@/lib/utils";
import { getEditorWorkspaceTabs, type EditorWorkspaceTab } from "./editor-workspace-navigation";
import { WORKSPACE_TOOL_ICONS } from "./workspace-tool-icons";

type EditorToolStripProps = {
  projectId: number;
  activeTab: string;
  subview?: string;
  isPublished: boolean;
  isMobile: boolean;
  chatOpen: boolean;
  pageMapSyncing: boolean;
  onNavigate: (target: WorkspaceToolOpen) => void;
  onOpenTools: () => void;
  onToggleChat: () => void;
};
const PRIMARY_TOOL_IDS = new Set<string>(
  WORKSPACE_TOOLS.filter((tool) => tool.placement === "primary").map((tool) => tool.open.tabId),
);

/** Each mounted project owns its navigation state. No cross-project or persistent storage. */
export function EditorToolStrip({ projectId, ...props }: EditorToolStripProps) {
  return <ProjectToolStrip key={projectId} {...props} />;
}
function ProjectToolStrip({
  activeTab,
  subview,
  isPublished,
  isMobile,
  chatOpen,
  pageMapSyncing,
  onNavigate,
  onOpenTools,
  onToggleChat,
}: Omit<EditorToolStripProps, "projectId">) {
  const [openTabs, setOpenTabs] = useState<EditorWorkspaceTab[]>([]);
  const rootRef = useRef<HTMLElement>(null);
  const tabs = getEditorWorkspaceTabs({ activeTab, subview, isPublished, openTabs });
  useEffect(() => {
    setOpenTabs((current) =>
      getEditorWorkspaceTabs({ activeTab, subview, isPublished, openTabs: current }),
    );
  }, [activeTab, subview, isPublished]);
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab, subview, isMobile]);
  const closeTab = (tab: EditorWorkspaceTab) => {
    setOpenTabs((current) => current.filter((item) => item.value !== tab.value));
    if (activeTab === tab.value) onNavigate({ kind: "workspace-tab", tabId: "preview" });
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>('[aria-current="page"]')
        ?.focus({ preventScroll: true });
    });
  };
  const tabButton = (tab: EditorWorkspaceTab, compact = false) => {
    const Icon = WORKSPACE_TOOL_ICONS[tab.toolId];
    return (
      <button
        type="button"
        onClick={() => onNavigate(tab.open)}
        aria-current={activeTab === tab.value && (!isMobile || !chatOpen) ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center justify-center gap-2 rounded-md text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "min-h-12 flex-1 flex-col gap-1 px-1 py-2 text-[10px]" : "min-h-10 px-3",
          activeTab === tab.value && (!isMobile || !chatOpen)
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
      >
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="max-w-40 truncate">{tab.label}</span>
        {tab.value === "page-map" && pageMapSyncing && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
            role="status"
            aria-label="Page map updating"
          />
        )}
      </button>
    );
  };
  const activeSecondary = tabs.find(
    (tab) => tab.value === activeTab && !PRIMARY_TOOL_IDS.has(tab.value),
  );
  return (
    <nav ref={rootRef} aria-label="Project tool navigation" className="shrink-0">
      {!isMobile ? (
        <div
          data-testid="workspace-core-tabs"
          className="flex min-w-0 items-center gap-1 border-b border-border bg-card/40 px-2 py-1"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.value}
                className={cn(
                  "flex shrink-0 items-center rounded-md",
                  activeTab === tab.value && "bg-muted",
                )}
              >
                {tabButton(tab)}
                {!PRIMARY_TOOL_IDS.has(tab.value) && (
                  <button
                    type="button"
                    aria-label={`Close ${tab.label} tab`}
                    title="Close this view, not its data"
                    onClick={() => closeTab(tab)}
                    className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={onOpenTools}
            aria-label="Open project tools"
            title="Add a tool (Ctrl K or Command K)"
            className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            <span>Add tool</span>
          </button>
        </div>
      ) : (
        <>
          {activeSecondary && !chatOpen && (
            <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3 text-xs">
              <span className="truncate font-medium">{activeSecondary.label}</span>
              <button
                type="button"
                aria-label={`Close ${activeSecondary.label} tab`}
                onClick={() => closeTab(activeSecondary)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          )}
          <div
            data-testid="workspace-mobile-tabs"
            className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-5 border-t border-border bg-card/95 px-1 backdrop-blur-sm"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            {tabs
              .filter((tab) => PRIMARY_TOOL_IDS.has(tab.value))
              .map((tab) => (
                <div key={tab.value} className="flex min-w-0">
                  {tabButton(tab, true)}
                </div>
              ))}
            <button
              type="button"
              aria-label="Open project tools"
              onClick={onOpenTools}
              className="flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-[10px] text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Tools
            </button>
            <button
              type="button"
              onClick={onToggleChat}
              aria-pressed={chatOpen}
              className={cn(
                "flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-[10px] focus-visible:ring-2 focus-visible:ring-ring",
                chatOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <MessageSquare aria-hidden="true" className="h-4 w-4" />
              Chat
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
