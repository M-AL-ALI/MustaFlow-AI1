import { useState, useCallback, useEffect, useRef } from "react";
import {
  useListKnowledge,
  useUpdateKnowledge,
  getListKnowledgeQueryKey,
} from "@workspace/api-client-react";
import type { KnowledgeEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Hammer,
  RefreshCw,
  RotateCcw,
  Globe,
  KeyRound,
  FilePen,
  FileWarning,
  NotebookPen,
  AlertTriangle,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Star,
  Archive,
  MessageSquare,
  Search,
  X,
  Clock,
  Plus,
} from "lucide-react";

const PAGE_SIZE = 20;

function getTypeIcon(type: string) {
  switch (type) {
    case "build":
      return Hammer;
    case "refine":
      return RefreshCw;
    case "rollback":
      return RotateCcw;
    case "publish":
    case "publish_failed":
      return Globe;
    case "secret_change":
      return KeyRound;
    case "manual_edit":
      return FilePen;
    case "secret_warning":
    case "integration_needed":
      return FileWarning;
    default:
      return NotebookPen;
  }
}

function getTypeColor(type: string, severity: string) {
  if (severity === "error") return "text-destructive border-destructive/40 bg-destructive/10";
  if (severity === "warning") return "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
  switch (type) {
    case "build":
      return "text-primary border-primary/40 bg-primary/10";
    case "refine":
      return "text-blue-400 border-blue-500/40 bg-blue-500/10";
    case "rollback":
      return "text-orange-400 border-orange-500/40 bg-orange-500/10";
    case "publish":
      return "text-green-400 border-green-500/40 bg-green-500/10";
    case "publish_failed":
      return "text-destructive border-destructive/40 bg-destructive/10";
    case "secret_change":
      return "text-purple-400 border-purple-500/40 bg-purple-500/10";
    case "manual_edit":
      return "text-cyan-400 border-cyan-500/40 bg-cyan-500/10";
    default:
      return "text-muted-foreground border-border bg-muted/40";
  }
}

function getTypeLabel(type: string) {
  const map: Record<string, string> = {
    build: "Build",
    refine: "Refine",
    rollback: "Rollback",
    publish: "Publish",
    publish_failed: "Publish failed",
    secret_change: "Secret",
    manual_edit: "Manual edit",
    secret_warning: "Warning",
    integration_needed: "Integration",
    note: "Note",
  };
  return map[type] ?? type;
}

function groupByDate(entries: KnowledgeEntry[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);

  const groups: { label: string; entries: KnowledgeEntry[] }[] = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "This Week", entries: [] },
    { label: "Earlier", entries: [] },
  ];

  for (const e of entries) {
    const d = new Date(e.createdAt);
    if (d >= today) groups[0]!.entries.push(e);
    else if (d >= yesterday) groups[1]!.entries.push(e);
    else if (d >= weekAgo) groups[2]!.entries.push(e);
    else groups[3]!.entries.push(e);
  }

  return groups.filter((g) => g.entries.length > 0);
}

const FILTER_OPTIONS = [
  { label: "All", value: "" },
  { label: "Builds", value: "build" },
  { label: "Refines", value: "refine" },
  { label: "Errors", value: "error" },
  { label: "Publishes", value: "publish" },
  { label: "Secrets", value: "secret_change" },
];

interface EntryCardProps {
  entry: KnowledgeEntry;
  projectId: number;
  onRetry?: (prompt: string) => void;
}

function EntryCard({ entry, projectId, onRetry }: EntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAnnotationInput, setShowAnnotationInput] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState(entry.annotation ?? "");
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showConfirmPromote, setShowConfirmPromote] = useState(false);
  const queryClient = useQueryClient();
  const updateKnowledge = useUpdateKnowledge();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey({ projectId }) });
    void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey({}) });
  }, [queryClient, projectId]);

  const saveAnnotation = () => {
    updateKnowledge.mutate(
      { id: entry.id, data: { annotation: annotationDraft || null } },
      {
        onSuccess: () => {
          setShowAnnotationInput(false);
          invalidate();
        },
      },
    );
  };

  const handleArchive = () => {
    setShowContextMenu(false);
    updateKnowledge.mutate(
      { id: entry.id, data: { archived: !entry.archivedAt } },
      { onSuccess: invalidate },
    );
  };

  const handlePromote = () => {
    setShowContextMenu(false);
    setShowConfirmPromote(false);
    updateKnowledge.mutate(
      { id: entry.id, data: { approvedForReuse: !entry.approvedForReuse } },
      { onSuccess: invalidate },
    );
  };

  const TypeIcon = getTypeIcon(entry.type);
  const typeColor = getTypeColor(entry.type, entry.severity);
  const SeverityIcon =
    entry.severity === "error"
      ? AlertTriangle
      : entry.severity === "warning"
        ? AlertTriangle
        : Info;
  const severityColor =
    entry.severity === "error"
      ? "text-destructive"
      : entry.severity === "warning"
        ? "text-yellow-400"
        : "text-muted-foreground";

  const diffSummary = entry.diffSummary as {
    filesAdded?: string[];
    filesModified?: string[];
    filesRemoved?: string[];
    linesAdded?: number;
    linesRemoved?: number;
  } | null;

  const hasDiff =
    diffSummary &&
    (diffSummary.filesAdded?.length ?? 0) +
      (diffSummary.filesModified?.length ?? 0) +
      (diffSummary.filesRemoved?.length ?? 0) >
      0;

  const isError = entry.severity === "error";

  // Extract retry prompt from error entry title patterns
  const retryPromptMatch =
    entry.title.match(/^Build failed: "(.+)"$/) ??
    entry.title.match(/^(?:Build|Refinement) error for: "(.+)"$/);
  const retryPrompt = retryPromptMatch ? retryPromptMatch[1] : null;

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2 bg-card/60 relative",
        entry.archivedAt ? "opacity-50" : "",
      )}
    >
      {/* Header row */}
      <div className="flex items-start gap-2.5">
        {/* Type icon */}
        <div
          className={cn(
            "w-7 h-7 rounded-md border flex items-center justify-center shrink-0 mt-0.5",
            typeColor,
          )}
        >
          <TypeIcon className="h-3.5 w-3.5" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-semibold text-foreground leading-tight flex-1 min-w-0 line-clamp-2">
              {entry.title}
            </span>
            {/* Severity badge */}
            <span
              className={cn(
                "shrink-0 flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wide",
                severityColor,
              )}
            >
              <SeverityIcon className="h-2.5 w-2.5" />
              {entry.severity}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium border", typeColor)}>
              {getTypeLabel(entry.type)}
            </span>
            {entry.approvedForReuse && (
              <span className="text-[9px] px-1.5 py-0.5 rounded font-medium border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 flex items-center gap-1">
                <Star className="h-2.5 w-2.5" /> Global
              </span>
            )}
            <span className="text-[9px] text-muted-foreground/60 ml-auto flex items-center gap-1 shrink-0">
              <Clock className="h-2.5 w-2.5" />
              {new Date(entry.createdAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Expand/collapse */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          {/* Annotation */}
          <button
            onClick={() => {
              setShowAnnotationInput((v) => !v);
              setShowContextMenu(false);
            }}
            className={cn(
              "w-5 h-5 flex items-center justify-center transition-colors",
              entry.annotation ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            title={entry.annotation ? "Edit note" : "Add note"}
          >
            <MessageSquare className="h-3 w-3" />
          </button>
          {/* Context menu */}
          <div className="relative">
            <button
              onClick={() => {
                setShowContextMenu((v) => !v);
                setShowAnnotationInput(false);
              }}
              className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
            {showContextMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
                {!showConfirmPromote ? (
                  <button
                    onClick={() => {
                      if (entry.approvedForReuse) {
                        handlePromote();
                      } else {
                        setShowConfirmPromote(true);
                      }
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-muted transition-colors"
                  >
                    <Star className="h-3 w-3 text-yellow-400" />
                    {entry.approvedForReuse ? "Remove from Global" : "Promote to Global"}
                  </button>
                ) : (
                  <div className="px-3 py-2 space-y-2">
                    <p className="text-[10px] text-muted-foreground leading-snug">
                      This lesson will be visible to the AI across all projects.
                    </p>
                    <div className="flex gap-1.5">
                      <Button size="sm" className="h-5 text-[10px] px-2" onClick={handlePromote}>
                        Confirm
                      </Button>
                      <button
                        onClick={() => setShowConfirmPromote(false)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <button
                  onClick={handleArchive}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-muted transition-colors"
                >
                  <Archive className="h-3 w-3 text-muted-foreground" />
                  {entry.archivedAt ? "Unarchive" : "Archive"}
                </button>
                <button
                  onClick={() => setShowContextMenu(false)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted transition-colors"
                >
                  <X className="h-3 w-3" /> Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Annotation display */}
      {entry.annotation && !showAnnotationInput && (
        <div className="text-[10px] text-muted-foreground bg-muted/40 border border-border/60 rounded px-2 py-1 italic">
          "{entry.annotation}"
        </div>
      )}

      {/* Annotation input */}
      {showAnnotationInput && (
        <div className="space-y-1.5">
          <textarea
            value={annotationDraft}
            onChange={(e) => setAnnotationDraft(e.target.value)}
            placeholder="Add a personal note…"
            rows={2}
            className="w-full text-[11px] bg-muted border border-border rounded px-2 py-1 resize-none focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/50"
            autoFocus
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="h-5 text-[10px] px-2"
              onClick={saveAnnotation}
              disabled={updateKnowledge.isPending}
            >
              Save
            </Button>
            <button
              onClick={() => {
                setShowAnnotationInput(false);
                setAnnotationDraft(entry.annotation ?? "");
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded: content + diff + error details */}
      {expanded && (
        <div className="space-y-2 pt-1 border-t border-border/50">
          {/* Error display */}
          {isError ? (
            <div className="space-y-1.5">
              <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                What went wrong
              </div>
              <pre className="text-[10px] text-destructive/80 bg-destructive/5 border border-destructive/20 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
                {entry.content}
              </pre>
              {retryPrompt && onRetry && (
                <div className="space-y-1">
                  <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                    What was tried
                  </div>
                  <div className="text-[10px] text-muted-foreground bg-muted/40 border border-border/60 rounded px-2 py-1 italic">
                    "{retryPrompt}"
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 text-[10px] px-2 border-destructive/30 text-destructive hover:bg-destructive/5"
                    onClick={() => onRetry(retryPrompt)}
                  >
                    <RefreshCw className="h-2.5 w-2.5 mr-1" /> Retry Build
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-relaxed">{entry.content}</p>
          )}

          {/* Diff summary */}
          {hasDiff && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 mb-1">
                <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                  File changes
                </div>
                {((diffSummary?.linesAdded ?? 0) > 0 || (diffSummary?.linesRemoved ?? 0) > 0) && (
                  <div className="flex gap-1.5 text-[9px]">
                    {(diffSummary?.linesAdded ?? 0) > 0 && (
                      <span className="text-green-400">+{diffSummary?.linesAdded} lines</span>
                    )}
                    {(diffSummary?.linesRemoved ?? 0) > 0 && (
                      <span className="text-red-400/70">-{diffSummary?.linesRemoved} lines</span>
                    )}
                  </div>
                )}
              </div>
              {(diffSummary?.filesAdded ?? []).map((f) => (
                <div
                  key={`a-${f}`}
                  className="font-mono text-[10px] text-green-400 flex items-center gap-1"
                >
                  <span className="shrink-0">+</span>
                  <span className="truncate">{f}</span>
                </div>
              ))}
              {(diffSummary?.filesModified ?? []).map((f) => (
                <div
                  key={`m-${f}`}
                  className="font-mono text-[10px] text-yellow-400 flex items-center gap-1"
                >
                  <span className="shrink-0">~</span>
                  <span className="truncate">{f}</span>
                </div>
              ))}
              {(diffSummary?.filesRemoved ?? []).map((f) => (
                <div
                  key={`r-${f}`}
                  className="font-mono text-[10px] text-red-400/70 flex items-center gap-1"
                >
                  <span className="shrink-0">-</span>
                  <span className="truncate">{f}</span>
                </div>
              ))}
            </div>
          )}

          {/* Version link */}
          {entry.relatedVersionId && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-green-500/70 shrink-0" />
              Snapshot saved (version #{entry.relatedVersionId})
            </div>
          )}

          {/* Tags */}
          {entry.tags && (
            <div className="flex flex-wrap gap-1">
              {entry.tags.split(",").map((tag) => (
                <span
                  key={tag}
                  className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground"
                >
                  {tag.trim()}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface HistoryTabProps {
  projectId: number;
  onRetry?: (prompt: string) => void;
  focusVersionId?: number | null;
}

export function HistoryTab({ projectId, onRetry, focusVersionId }: HistoryTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Pagination: accumulated entries across pages
  const [page, setPage] = useState(0);
  const [accumulated, setAccumulated] = useState<KnowledgeEntry[]>([]);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `mustaflow_scroll_${projectId}_history`;

  // Reset pagination when filters change
  const resetPagination = () => {
    setPage(0);
    setAccumulated([]);
  };

  const queryParams = {
    projectId,
    archived: showArchived,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const {
    data: pageEntries = [],
    isLoading,
    isFetching,
  } = useListKnowledge(queryParams, { query: { queryKey: getListKnowledgeQueryKey(queryParams) } });

  // Accumulate pages as the user loads more
  useEffect(() => {
    if (pageEntries.length === 0 && page === 0) {
      setAccumulated([]);
      return;
    }
    if (page === 0) {
      setAccumulated(pageEntries);
    } else {
      setAccumulated((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const newEntries = pageEntries.filter((e) => !existingIds.has(e.id));
        return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageEntries]);

  // Entries to display: accumulated (or empty while first page loads)
  const allEntries = accumulated;
  const hasMore = pageEntries.length === PAGE_SIZE;

  const filtered = allEntries.filter((e) => {
    if (typeFilter === "error" && e.severity !== "error") return false;
    if (typeFilter && typeFilter !== "error" && e.type !== typeFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q);
    }
    return true;
  });

  const grouped = groupByDate(filtered);

  // Guard: true once the saved scroll has been successfully applied after content renders.
  const scrollRestoredRef = useRef(false);

  // When a specific version is focused (e.g. from chat bubble "View in history"), scroll to top
  // so the most-recent build entry (which corresponds to that version) is visible immediately.
  useEffect(() => {
    if (!focusVersionId) return;
    scrollRestoredRef.current = false;
    const el = historyScrollRef.current;
    if (el) el.scrollTop = 0;
  }, [focusVersionId]);

  // Save on pagehide (hard refresh / tab close) and on unmount (SPA navigation / tab switch).
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(scrollKey, String(historyScrollRef.current?.scrollTop ?? 0));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
    // scrollKey is stable for the component lifetime (projectId is fixed via key={projectId})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore saved scroll after entries have loaded and rendered.
  // Runs every time `accumulated.length` grows so the offset is re-attempted once content is tall
  // enough. The guard ref prevents re-applying after the user has intentionally scrolled.
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    const el = historyScrollRef.current;
    if (!el) return;
    try {
      const raw = localStorage.getItem(scrollKey);
      if (raw === null) {
        scrollRestoredRef.current = true;
        return;
      }
      const top = Number.isFinite(Number(raw)) ? Number(raw) : 0;
      if (top === 0) {
        scrollRestoredRef.current = true;
        return;
      }
      requestAnimationFrame(() => {
        if (!el || scrollRestoredRef.current) return;
        el.scrollTop = top;
        if (el.scrollTop >= top - 2) {
          scrollRestoredRef.current = true;
        }
      });
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accumulated.length]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header + controls */}
      <div className="px-3 py-2 border-b border-border/50 space-y-2">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex-1">
            Project History
          </span>
          <button
            onClick={() => {
              setShowArchived((v) => !v);
              resetPagination();
            }}
            className={cn(
              "text-[9px] px-1.5 py-0.5 rounded border transition-colors",
              showArchived
                ? "border-primary/30 text-primary bg-primary/10"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        </div>
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/60" />
          <input
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            placeholder="Search history…"
            className="w-full bg-muted border border-border rounded-md pl-6 pr-6 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {/* Filter chips */}
        <div className="flex gap-1 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setTypeFilter(opt.value === typeFilter ? "" : opt.value);
              }}
              className={cn(
                "text-[9px] px-2 py-0.5 rounded-full border font-medium transition-colors",
                typeFilter === opt.value
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/30",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div ref={historyScrollRef} className="flex-1 overflow-y-auto py-3 px-3 space-y-4">
        {isLoading && accumulated.length === 0 && (
          <div className="flex items-center justify-center h-24 text-muted-foreground text-[11px]">
            Loading history…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-24 gap-2 text-muted-foreground">
            <Clock className="h-7 w-7 opacity-20" />
            <div className="text-center">
              <div className="text-xs font-medium text-foreground/60">No history yet</div>
              <div className="text-[10px] opacity-50 mt-0.5">
                Events are recorded automatically as you build
              </div>
            </div>
          </div>
        )}
        {grouped.map((group) => (
          <div key={group.label} className="space-y-2">
            <div className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-widest">
              {group.label}
            </div>
            <div className="space-y-2">
              {group.entries.map((entry) => (
                <EntryCard key={entry.id} entry={entry} projectId={projectId} onRetry={onRetry} />
              ))}
            </div>
          </div>
        ))}

        {/* Load more */}
        {hasMore && !searchQuery && (
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={isFetching}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-[10px] text-muted-foreground hover:text-foreground border border-border/50 rounded-lg hover:border-border transition-colors disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            {isFetching ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
