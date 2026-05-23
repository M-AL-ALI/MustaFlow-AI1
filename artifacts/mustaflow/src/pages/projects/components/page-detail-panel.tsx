import { useState, useEffect, useMemo, type ReactNode } from "react";
import {
  X,
  ExternalLink,
  Pencil,
  FileCode2,
  FilePlus,
  Trash2,
  Unlink,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Link2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PageType } from "./page-node";

export type PageMapNodeState = {
  id: string;
  label: string;
  pageType: PageType;
  filePath: string;
  position: { x: number; y: number };
  isNew: boolean;
  hasError: boolean;
  aiGenerated: boolean;
  notes: string;
  planned?: boolean;
};

export type WiringPage = {
  id: string;
  label: string;
  pageType: PageType;
  planned?: boolean;
};

export type WiringEdge = {
  edgeId: string;
  page: WiringPage;
};

const WEB_PAGE_TYPES: { value: PageType; label: string }[] = [
  { value: "landing", label: "Landing Page" },
  { value: "auth", label: "Auth / Login" },
  { value: "form", label: "Form" },
  { value: "dashboard", label: "Dashboard" },
  { value: "modal", label: "Modal / Overlay" },
  { value: "settings", label: "Settings" },
  { value: "404", label: "404 / Error" },
  { value: "list", label: "List View" },
  { value: "detail", label: "Detail View" },
  { value: "other", label: "Other" },
];

type PageDetailPanelProps = {
  node: PageMapNodeState | null;
  // Wiring context — computed by parent from current edges/nodes.
  incoming?: WiringEdge[];
  outgoing?: WiringEdge[];
  availableTargets?: WiringPage[];
  isOrphan?: boolean;
  isDeadEnd?: boolean;
  onClose: () => void;
  onSave: (updated: PageMapNodeState) => void;
  onFileOpen: (filePath: string) => void;
  onModifyPage: (node: PageMapNodeState) => void;
  onDelete: (nodeId: string) => void;
  onJumpToNode?: (nodeId: string) => void;
  onWireTo?: (targetNodeId: string) => void;
  onUnwire?: (edgeId: string) => void;
  onAskAiToWire?: (node: PageMapNodeState) => void;
  /**
   * Optional slot rendered below the file path on built pages. Used to host
   * the BlocksPanel (drag-to-reorder + cross-page move) without coupling this
   * UI-only component to project/file fetching.
   */
  blocksSlot?: ReactNode;
};

export function PageDetailPanel({
  node,
  incoming = [],
  outgoing = [],
  availableTargets = [],
  isOrphan = false,
  isDeadEnd = false,
  onClose,
  onSave,
  onFileOpen,
  onModifyPage,
  onDelete,
  onJumpToNode,
  onWireTo,
  onUnwire,
  onAskAiToWire,
  blocksSlot,
}: PageDetailPanelProps) {
  const [label, setLabel] = useState("");
  const [pageType, setPageType] = useState<PageType>("other");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [wireTarget, setWireTarget] = useState<string>("");

  useEffect(() => {
    if (node) {
      setLabel(node.label);
      setPageType(node.pageType);
      setNotes(node.notes ?? "");
      setDirty(false);
      setConfirmDelete(false);
      setWireTarget("");
    }
  }, [node]);

  const hasWiringIssue = isOrphan || isDeadEnd;

  const wiringTargetOptions = useMemo(
    () => availableTargets.filter((p) => p.id !== node?.id),
    [availableTargets, node?.id],
  );

  if (!node) return null;

  const handleSave = () => {
    onSave({ ...node, label, pageType, notes });
    setDirty(false);
  };

  const handleWireTo = () => {
    if (!wireTarget || !onWireTo) return;
    onWireTo(wireTarget);
    setWireTarget("");
  };

  return (
    <div
      className={cn(
        "absolute right-0 top-0 bottom-0 w-80 bg-card border-l border-border shadow-xl z-20",
        "flex flex-col transition-transform duration-200",
        node ? "translate-x-0" : "translate-x-full",
      )}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-card/80">
        <span className="text-sm font-semibold text-foreground truncate">{node.label}</span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Wiring issue callout */}
        {hasWiringIssue && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              {isOrphan && isDeadEnd
                ? "Disconnected page"
                : isOrphan
                  ? "No way to reach this page"
                  : "This page goes nowhere"}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {isOrphan && isDeadEnd
                ? "Nothing links to this page and it links to nothing. Wire it below or ask the AI to integrate it."
                : isOrphan
                  ? "No other page links here. Add an incoming link, or ask the AI to add navigation from your main pages."
                  : "This page has no outgoing links. Most pages should let users navigate forward or back."}
            </p>
          </div>
        )}

        {/* Name */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Page Name
          </label>
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setDirty(true);
            }}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow"
            placeholder="Page name"
          />
        </div>

        {/* Type */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Page Type
          </label>
          <select
            value={pageType}
            onChange={(e) => {
              setPageType(e.target.value as PageType);
              setDirty(true);
            }}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow"
          >
            {WEB_PAGE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setDirty(true);
            }}
            rows={3}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow resize-none"
            placeholder="Add notes about this page…"
          />
        </div>

        {/* Wiring — incoming */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Linked from
            </label>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {incoming.length}
            </span>
          </div>
          {incoming.length === 0 ? (
            <div className="text-[11px] text-muted-foreground italic px-1">Nothing links here.</div>
          ) : (
            <div className="space-y-1">
              {incoming.map(({ edgeId, page }) => (
                <div
                  key={edgeId}
                  className="flex items-center gap-1.5 bg-muted/40 border border-border rounded-md px-2 py-1.5 group"
                >
                  <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  <button
                    onClick={() => onJumpToNode?.(page.id)}
                    className="flex-1 text-left text-[11px] text-foreground truncate hover:text-primary transition-colors"
                  >
                    {page.label}
                  </button>
                  {onUnwire && (
                    <button
                      onClick={() => onUnwire(edgeId)}
                      title="Remove this link"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    >
                      <Unlink className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Wiring — outgoing */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Links to
            </label>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {outgoing.length}
            </span>
          </div>
          {outgoing.length === 0 ? (
            <div className="text-[11px] text-muted-foreground italic px-1">
              This page links nowhere.
            </div>
          ) : (
            <div className="space-y-1">
              {outgoing.map(({ edgeId, page }) => (
                <div
                  key={edgeId}
                  className="flex items-center gap-1.5 bg-muted/40 border border-border rounded-md px-2 py-1.5 group"
                >
                  <ArrowLeft className="h-3 w-3 text-muted-foreground shrink-0 rotate-180" />
                  <button
                    onClick={() => onJumpToNode?.(page.id)}
                    className="flex-1 text-left text-[11px] text-foreground truncate hover:text-primary transition-colors"
                  >
                    {page.label}
                  </button>
                  {onUnwire && (
                    <button
                      onClick={() => onUnwire(edgeId)}
                      title="Remove this link"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    >
                      <Unlink className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {wiringTargetOptions.length > 0 && onWireTo && (
            <div className="flex gap-1.5 pt-1">
              <select
                value={wireTarget}
                onChange={(e) => setWireTarget(e.target.value)}
                className="flex-1 bg-muted border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="">Wire to a page…</option>
                {wiringTargetOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.planned ? " (planned)" : ""}
                  </option>
                ))}
              </select>
              <Button
                onClick={handleWireTo}
                disabled={!wireTarget}
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px] gap-1"
              >
                <Link2 className="h-3 w-3" />
                Link
              </Button>
            </div>
          )}
        </div>

        {/* File path — only shown for built pages */}
        {!node.planned && (
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              File Path
            </label>
            <button
              onClick={() => onFileOpen(node.filePath)}
              className="w-full flex items-center gap-2 bg-muted border border-border rounded-lg px-3 py-2 text-left hover:border-primary/40 hover:bg-muted/80 transition-colors group"
            >
              <FileCode2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-[11px] font-mono text-muted-foreground truncate flex-1">
                {node.filePath}
              </span>
              <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-60 shrink-0 transition-opacity" />
            </button>
          </div>
        )}

        {/* Blocks panel — hosted by parent (drag-to-reorder + cross-file move) */}
        {!node.planned && blocksSlot}

        {/* Metadata badges */}
        <div className="flex flex-wrap gap-1.5">
          {node.planned && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-semibold">
              Planned — not built yet
            </span>
          )}
          {node.aiGenerated && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-semibold">
              AI-generated
            </span>
          )}
          {node.isNew && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20 font-semibold">
              New in last build
            </span>
          )}
          {node.hasError && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20 font-semibold">
              Has errors
            </span>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="shrink-0 border-t border-border px-4 py-3 space-y-2">
        {hasWiringIssue && onAskAiToWire && (
          <Button
            onClick={() => onAskAiToWire(node)}
            variant="default"
            className="w-full h-8 text-xs gap-1.5"
          >
            <Sparkles className="h-3 w-3" />
            Ask AI to wire this page
          </Button>
        )}
        <Button
          onClick={() => onModifyPage(node)}
          variant="outline"
          className="w-full h-8 text-xs gap-1.5"
        >
          {node.planned ? <FilePlus className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
          {node.planned ? "Build this page" : "Modify this page"}
        </Button>
        <Button onClick={handleSave} disabled={!dirty} className="w-full h-8 text-xs">
          Save changes
        </Button>
        {node.planned ? (
          <Button
            onClick={() => onDelete(node.id)}
            variant="ghost"
            className="w-full h-8 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3" />
            Remove from map
          </Button>
        ) : confirmDelete ? (
          <div className="flex gap-2">
            <Button
              onClick={() => onDelete(node.id)}
              variant="destructive"
              className="flex-1 h-8 text-xs gap-1.5"
            >
              <Trash2 className="h-3 w-3" />
              Confirm remove
            </Button>
            <Button
              onClick={() => setConfirmDelete(false)}
              variant="ghost"
              className="flex-1 h-8 text-xs"
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => setConfirmDelete(true)}
            variant="ghost"
            className="w-full h-8 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3" />
            Remove from map
          </Button>
        )}
      </div>
    </div>
  );
}
