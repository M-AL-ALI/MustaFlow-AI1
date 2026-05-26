import { useState, useEffect, useRef, useCallback } from "react";
import {
  Search,
  FolderOpen,
  FileSearch,
  Lock,
  Package,
  GitBranch,
  Database,
  Boxes,
  Gauge,
  Wrench,
  Terminal,
  Eye,
  Code2,
  LayoutTemplate,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PanelId } from "./icon-rail";

interface ToolItem {
  id: PanelId | string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string[];
  panelId?: PanelId;
}

const TOOL_ITEMS: ToolItem[] = [
  {
    id: "files",
    label: "Files",
    description: "Browse and edit project files",
    icon: FolderOpen,
    panelId: "files",
    keywords: ["explorer", "tree"],
  },
  {
    id: "editor",
    label: "Editor",
    description: "Open the code editor",
    icon: Code2,
    panelId: "files",
    keywords: ["code", "monaco", "edit"],
  },
  {
    id: "search",
    label: "Search",
    description: "Search across all project files",
    icon: FileSearch,
    panelId: "search",
    keywords: ["find", "grep"],
  },
  {
    id: "preview",
    label: "Preview",
    description: "View your app in the live preview pane",
    icon: Eye,
    panelId: "files",
    keywords: ["browser", "view", "app"],
  },
  {
    id: "tools",
    label: "Tools",
    description: "Browse all available tools",
    icon: Wrench,
    panelId: "tools",
    keywords: ["panel"],
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Manage environment variables and API keys",
    icon: Lock,
    panelId: "secrets",
    keywords: ["env", "api key", "token", "environment"],
  },
  {
    id: "packages",
    label: "Packages",
    description: "Install and manage npm / pip dependencies",
    icon: Package,
    panelId: "packages",
    keywords: ["npm", "pip", "install", "dependencies"],
  },
  {
    id: "git",
    label: "Version Control",
    description: "Commit, push, and manage branches",
    icon: GitBranch,
    panelId: "git",
    keywords: ["github", "commit", "push", "branch"],
  },
  {
    id: "database",
    label: "Database",
    description: "Browse tables, run queries, manage schema",
    icon: Database,
    panelId: "database",
    keywords: ["sql", "postgres", "table", "query"],
  },
  {
    id: "storage",
    label: "Object Storage",
    description: "Upload and manage files and assets",
    icon: Boxes,
    panelId: "storage",
    keywords: ["upload", "files", "cdn", "assets"],
  },
  {
    id: "resources",
    label: "Resources",
    description: "CPU, RAM, and disk usage metrics",
    icon: Gauge,
    panelId: "resources",
    keywords: ["cpu", "memory", "disk", "monitor"],
  },
  {
    id: "terminal",
    label: "Shell",
    description: "Run commands in the project container",
    icon: Terminal,
    panelId: "files",
    keywords: ["cli", "bash", "shell", "command"],
  },
  {
    id: "canvas",
    label: "Canvas",
    description: "Visual layout and component editor",
    icon: LayoutTemplate,
    panelId: "canvas",
    keywords: ["design", "mockup", "layout"],
  },
];

interface ToolsSearchPopupProps {
  open: boolean;
  onClose: () => void;
  onSelect: (panelId: PanelId) => void;
}

export function ToolsSearchPopup({ open, onClose, onSelect }: ToolsSearchPopupProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query.trim()
    ? TOOL_ITEMS.filter((t) => {
        const q = query.toLowerCase();
        return (
          t.label.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.keywords?.some((k) => k.toLowerCase().includes(q))
        );
      })
    : TOOL_ITEMS;

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const handleSelect = useCallback(
    (item: ToolItem) => {
      // Use panelId if specified, otherwise fall back to id cast as PanelId
      const target = item.panelId !== undefined ? item.panelId : (item.id as PanelId);
      if (target !== null) onSelect(target);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[cursor]) handleSelect(filtered[cursor]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [cursor, filtered, handleSelect, onClose],
  );

  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Popup */}
      <div className="relative w-full max-w-md bg-zinc-900 border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tools…"
            className="flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground/60"
          />
          <kbd className="text-[10px] text-muted-foreground bg-muted border border-border rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No tools match &quot;{query}&quot;
            </div>
          ) : (
            filtered.map((item, idx) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setCursor(idx)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
                    idx === cursor
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center justify-center h-8 w-8 rounded-lg shrink-0 border transition-colors",
                      idx === cursor
                        ? "bg-primary/20 border-primary/30 text-primary"
                        : "bg-muted/60 border-border text-muted-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-sm font-medium",
                        idx === cursor ? "text-foreground" : "text-foreground/80",
                      )}
                    >
                      {item.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {item.description}
                    </div>
                  </div>
                  {idx === cursor && (
                    <kbd className="text-[10px] text-muted-foreground bg-muted border border-border rounded px-1.5 py-0.5 shrink-0">
                      ↵
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>
            <kbd className="bg-muted border border-border rounded px-1">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="bg-muted border border-border rounded px-1">↵</kbd> open
          </span>
          <span>
            <kbd className="bg-muted border border-border rounded px-1">esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="bg-muted border border-border rounded px-1">⌘K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
