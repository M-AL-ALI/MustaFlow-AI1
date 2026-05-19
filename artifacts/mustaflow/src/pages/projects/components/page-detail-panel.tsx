import { useState, useEffect } from "react";
import { X, ExternalLink, Pencil, FileCode2 } from "lucide-react";
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
};

const WEB_PAGE_TYPES: { value: PageType; label: string }[] = [
  { value: "landing",   label: "Landing Page" },
  { value: "auth",      label: "Auth / Login" },
  { value: "form",      label: "Form" },
  { value: "dashboard", label: "Dashboard" },
  { value: "modal",     label: "Modal / Overlay" },
  { value: "settings",  label: "Settings" },
  { value: "404",       label: "404 / Error" },
  { value: "list",      label: "List View" },
  { value: "detail",    label: "Detail View" },
  { value: "other",     label: "Other" },
];

type PageDetailPanelProps = {
  node: PageMapNodeState | null;
  onClose: () => void;
  onSave: (updated: PageMapNodeState) => void;
  onFileOpen: (filePath: string) => void;
  onModifyPage: (node: PageMapNodeState) => void;
};

export function PageDetailPanel({ node, onClose, onSave, onFileOpen, onModifyPage }: PageDetailPanelProps) {
  const [label, setLabel] = useState("");
  const [pageType, setPageType] = useState<PageType>("other");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (node) {
      setLabel(node.label);
      setPageType(node.pageType);
      setNotes(node.notes ?? "");
      setDirty(false);
    }
  }, [node?.id]);

  if (!node) return null;

  const handleSave = () => {
    onSave({ ...node, label, pageType, notes });
    setDirty(false);
  };

  return (
    <div
      className={cn(
        "absolute right-0 top-0 bottom-0 w-72 bg-card border-l border-border shadow-xl z-20",
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
        {/* Name */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Page Name
          </label>
          <input
            value={label}
            onChange={(e) => { setLabel(e.target.value); setDirty(true); }}
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
            onChange={(e) => { setPageType(e.target.value as PageType); setDirty(true); }}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow"
          >
            {WEB_PAGE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
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
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
            rows={3}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow resize-none"
            placeholder="Add notes about this page…"
          />
        </div>

        {/* File path */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            File Path
          </label>
          <button
            onClick={() => onFileOpen(node.filePath)}
            className="w-full flex items-center gap-2 bg-muted border border-border rounded-lg px-3 py-2 text-left hover:border-primary/40 hover:bg-muted/80 transition-colors group"
          >
            <FileCode2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-mono text-muted-foreground truncate flex-1">{node.filePath}</span>
            <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-60 shrink-0 transition-opacity" />
          </button>
        </div>

        {/* Metadata badges */}
        <div className="flex flex-wrap gap-1.5">
          {node.aiGenerated && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-semibold">AI-generated</span>
          )}
          {node.isNew && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20 font-semibold">New in last build</span>
          )}
          {node.hasError && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20 font-semibold">Has errors</span>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="shrink-0 border-t border-border px-4 py-3 space-y-2">
        <Button
          onClick={() => onModifyPage(node)}
          variant="outline"
          className="w-full h-8 text-xs gap-1.5"
        >
          <Pencil className="h-3 w-3" />
          Modify this page
        </Button>
        <Button
          onClick={handleSave}
          disabled={!dirty}
          className="w-full h-8 text-xs"
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}
