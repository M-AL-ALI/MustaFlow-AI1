import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileCode2,
  FileJson,
  FileText,
  Globe,
  FileCog,
  FileType,
  Search,
  Wand2,
  Keyboard,
  Settings,
  Terminal,
  GitBranch,
  Package,
  Bug,
  Layers,
  ChevronRight,
  Clock,
  Hash,
  Play,
  RotateCcw,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getRecentFiles, pushRecentFile } from "./recent-files";

export { pushRecentFile } from "./recent-files";

export interface PaletteFile {
  id: number;
  path: string;
  mimeType?: string;
}

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  category: "command" | "ai" | "setting" | "navigation";
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  files: PaletteFile[];
  projectId: number;
  onOpenFile: (fileId: number) => void;
  onSendMessage?: (text: string) => void;
  onNavigate?: (tab: string) => void;
  extraCommands?: PaletteCommand[];
}

const AI_QUICK_ACTIONS = [
  { id: "ai-explain", label: "Explain this project", icon: <Wand2 className="h-3.5 w-3.5" /> },
  { id: "ai-improve", label: "Suggest improvements", icon: <Zap className="h-3.5 w-3.5" /> },
  { id: "ai-tests", label: "Add tests to the project", icon: <Play className="h-3.5 w-3.5" /> },
  {
    id: "ai-refactor",
    label: "Refactor for performance",
    icon: <RotateCcw className="h-3.5 w-3.5" />,
  },
  {
    id: "ai-docs",
    label: "Generate documentation",
    icon: <FileText className="h-3.5 w-3.5" />,
  },
  { id: "ai-security", label: "Review for security issues", icon: <Bug className="h-3.5 w-3.5" /> },
];

function fileIcon(path: string) {
  if (path.endsWith(".html") || path.endsWith(".htm"))
    return <Globe className="h-3.5 w-3.5 text-orange-400" />;
  if (path.endsWith(".css")) return <FileType className="h-3.5 w-3.5 text-blue-400" />;
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return <FileCog className="h-3.5 w-3.5 text-yellow-400" />;
  if (path.endsWith(".ts") || path.endsWith(".tsx"))
    return <FileCog className="h-3.5 w-3.5 text-blue-500" />;
  if (path.endsWith(".json")) return <FileJson className="h-3.5 w-3.5 text-green-400" />;
  if (path.endsWith(".md")) return <FileText className="h-3.5 w-3.5 text-muted-foreground" />;
  return <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />;
}

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  if (t.includes(q)) return 80;
  return 50;
}

type PaletteItem =
  | { kind: "file"; file: PaletteFile; score: number }
  | { kind: "recent-file"; file: PaletteFile; score: number }
  | { kind: "command"; command: PaletteCommand; score: number }
  | { kind: "ai-action"; id: string; label: string; icon: React.ReactNode; score: number }
  | { kind: "line-jump"; fileId: number; line: number; query: string; score: number };

export function CommandPalette({
  open,
  onClose,
  files,
  projectId: _projectId,
  onOpenFile,
  onSendMessage,
  onNavigate,
  extraCommands = [],
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recentFileIds = useMemo(() => getRecentFiles(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const builtinCommands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: "nav-preview",
        label: "Go to Preview",
        icon: <Globe className="h-3.5 w-3.5" />,
        category: "navigation",
        shortcut: "P",
        action: () => onNavigate?.("preview"),
      },
      {
        id: "nav-code",
        label: "Go to Code Editor",
        icon: <FileCode2 className="h-3.5 w-3.5" />,
        category: "navigation",
        shortcut: "E",
        action: () => onNavigate?.("code"),
      },
      {
        id: "nav-terminal",
        label: "Open Terminal",
        icon: <Terminal className="h-3.5 w-3.5" />,
        category: "navigation",
        shortcut: "`",
        action: () => onNavigate?.("terminal"),
      },
      {
        id: "nav-git",
        label: "Open Git",
        icon: <GitBranch className="h-3.5 w-3.5" />,
        category: "navigation",
        action: () => onNavigate?.("git"),
      },
      {
        id: "nav-packages",
        label: "Open Package Manager",
        icon: <Package className="h-3.5 w-3.5" />,
        category: "navigation",
        action: () => onNavigate?.("packages"),
      },
      {
        id: "nav-debugger",
        label: "Open Debugger",
        icon: <Bug className="h-3.5 w-3.5" />,
        category: "navigation",
        action: () => onNavigate?.("debugger"),
      },
      {
        id: "nav-shortcuts",
        label: "Show Keyboard Shortcuts",
        icon: <Keyboard className="h-3.5 w-3.5" />,
        category: "setting",
        shortcut: "⌘/",
        action: () => onNavigate?.("shortcuts"),
      },
      {
        id: "nav-snippets",
        label: "Open Snippet Library",
        icon: <Layers className="h-3.5 w-3.5" />,
        category: "navigation",
        action: () => onNavigate?.("snippets"),
      },
      {
        id: "nav-tools",
        label: "Go to Tools & Files",
        icon: <Settings className="h-3.5 w-3.5" />,
        category: "navigation",
        action: () => onNavigate?.("tools-files"),
      },
      ...extraCommands,
    ],
    [onNavigate, extraCommands],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();

    if (!q) {
      const recentItems: PaletteItem[] = recentFileIds
        .map((id) => files.find((f) => f.id === id))
        .filter(Boolean)
        .map((file) => ({ kind: "recent-file" as const, file: file!, score: 90 }));

      const cmdItems: PaletteItem[] = builtinCommands.map((cmd) => ({
        kind: "command" as const,
        command: cmd,
        score: 50,
      }));

      return [...recentItems.slice(0, 5), ...cmdItems.slice(0, 5)];
    }

    const all: PaletteItem[] = [];

    if (q.startsWith(":") && q.length > 1) {
      const line = parseInt(q.slice(1), 10);
      if (!isNaN(line) && files.length > 0) {
        all.push({ kind: "line-jump", fileId: 0, line, query: q, score: 100 });
      }
      return all;
    }

    for (const file of files) {
      if (fuzzyMatch(file.path, q)) {
        all.push({ kind: "file", file, score: fuzzyScore(file.path, q) });
      }
    }

    for (const cmd of builtinCommands) {
      const text = `${cmd.label} ${cmd.description ?? ""}`;
      if (fuzzyMatch(text, q)) {
        all.push({ kind: "command", command: cmd, score: fuzzyScore(text, q) });
      }
    }

    for (const ai of AI_QUICK_ACTIONS) {
      if (fuzzyMatch(ai.label, q)) {
        all.push({
          kind: "ai-action",
          id: ai.id,
          label: ai.label,
          icon: ai.icon,
          score: fuzzyScore(ai.label, q),
        });
      }
    }

    return all.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [query, files, builtinCommands, recentFileIds]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [items.length]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const executeItem = useCallback(
    (item: PaletteItem) => {
      if (item.kind === "file" || item.kind === "recent-file") {
        pushRecentFile(item.file.id);
        onOpenFile(item.file.id);
        onClose();
      } else if (item.kind === "command") {
        item.command.action();
        onClose();
      } else if (item.kind === "ai-action") {
        const aiMap: Record<string, string> = {
          "ai-explain":
            "Explain how this project works, what each file does, and its overall architecture.",
          "ai-improve":
            "Review the codebase and suggest 3-5 concrete improvements for quality, performance, or UX.",
          "ai-tests":
            "Add comprehensive tests to this project, covering the key features and edge cases.",
          "ai-refactor":
            "Refactor the code for better performance and maintainability without changing functionality.",
          "ai-docs": "Generate inline documentation and a README for this project.",
          "ai-security":
            "Review the codebase for security vulnerabilities and fix any issues found.",
        };
        const msg = aiMap[item.id];
        if (msg) onSendMessage?.(msg);
        onClose();
      } else if (item.kind === "line-jump") {
        onClose();
      }
    },
    [onOpenFile, onSendMessage, onClose],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[selectedIdx];
        if (item) executeItem(item);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, selectedIdx, executeItem, onClose]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, open]);

  if (!open) return null;

  function categoryLabel(item: PaletteItem): string {
    if (item.kind === "recent-file") return "Recent";
    if (item.kind === "file") return "Files";
    if (item.kind === "command") {
      const cat = item.command.category;
      if (cat === "navigation") return "Navigate";
      if (cat === "ai") return "AI";
      if (cat === "setting") return "Settings";
      return "Commands";
    }
    if (item.kind === "ai-action") return "AI Actions";
    return "";
  }

  const groupedSections: { label: string; items: Array<{ item: PaletteItem; idx: number }> }[] = [];
  let lastLabel = "";
  items.forEach((item, idx) => {
    const lbl = categoryLabel(item);
    if (lbl !== lastLabel) {
      groupedSections.push({ label: lbl, items: [{ item, idx }] });
      lastLabel = lbl;
    } else {
      groupedSections[groupedSections.length - 1]!.items.push({ item, idx });
    }
  });

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-xl mx-4 bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files, commands, AI actions… (type : to go to line)"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
          <kbd className="text-[10px] text-muted-foreground/50 border border-border rounded px-1 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {groupedSections.map((section) => (
            <div key={section.label}>
              <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                {section.label}
              </div>
              {section.items.map(({ item, idx }) => {
                const isSelected = idx === selectedIdx;
                return (
                  <button
                    key={idx}
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors",
                      isSelected ? "bg-primary/10" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {item.kind === "file" || item.kind === "recent-file" ? (
                        fileIcon(item.file.path)
                      ) : item.kind === "command" ? (
                        (item.command.icon ?? <Hash className="h-3.5 w-3.5" />)
                      ) : item.kind === "ai-action" ? (
                        item.icon
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </span>

                    <span className="flex-1 min-w-0">
                      <span className="text-sm text-foreground truncate block">
                        {item.kind === "file" || item.kind === "recent-file"
                          ? item.file.path
                          : item.kind === "command"
                            ? item.command.label
                            : item.kind === "ai-action"
                              ? item.label
                              : `Jump to line ${item.line}`}
                      </span>
                      {item.kind === "command" && item.command.description && (
                        <span className="text-[11px] text-muted-foreground truncate block">
                          {item.command.description}
                        </span>
                      )}
                      {item.kind === "recent-file" && (
                        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" /> Recent
                        </span>
                      )}
                    </span>

                    {item.kind === "command" && item.command.shortcut && (
                      <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 font-mono shrink-0">
                        {item.command.shortcut}
                      </kbd>
                    )}

                    {isSelected && <ChevronRight className="h-3 w-3 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="px-3 py-1.5 border-t border-border flex items-center gap-3 text-[10px] text-muted-foreground/50">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> select
          </span>
          <span>
            <kbd className="font-mono">ESC</kbd> close
          </span>
          <span className="ml-auto">
            Tip: type <kbd className="font-mono">:</kbd> for line jump
          </span>
        </div>
      </div>
    </div>
  );
}
