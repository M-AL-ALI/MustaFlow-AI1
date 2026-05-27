import { useState, useMemo, useCallback } from "react";
import {
  useListKnowledge,
  useUpdateKnowledge,
  useCreateKnowledge,
  usePromoteKnowledgeToGlobal,
  getListKnowledgeQueryKey,
} from "@workspace/api-client-react";
import type { KnowledgeEntry, KnowledgeInput } from "@workspace/api-client-react";
import { useClerkUser } from "@/lib/clerk-safe";
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
  Star,
  Archive,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Clock,
  MoreHorizontal,
  BrainCircuit,
  Loader2,
  CheckCircle2,
  CheckSquare,
  Square,
  Plus,
  Share2,
} from "lucide-react";

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

function KnowledgeEntryCard({
  entry,
  onUpdate,
  selectionMode,
  selected,
  onToggleSelect,
  currentUserId,
  projectId,
}: {
  entry: KnowledgeEntry;
  onUpdate: () => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: number) => void;
  currentUserId?: string;
  projectId: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAnnotationInput, setShowAnnotationInput] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState(entry.annotation ?? "");
  const [showMenu, setShowMenu] = useState(false);
  const [showConfirmPromote, setShowConfirmPromote] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [promotePending, setPromotePending] = useState(false);
  const [promoteSuccess, setPromoteSuccess] = useState(false);
  const updateKnowledge = useUpdateKnowledge();
  const promoteToGlobal = usePromoteKnowledgeToGlobal();

  const TypeIcon = getTypeIcon(entry.type);
  const typeColor = getTypeColor(entry.type, entry.severity);
  const SeverityIcon =
    entry.severity === "error" || entry.severity === "warning" ? AlertTriangle : Info;
  const severityColor =
    entry.severity === "error"
      ? "text-destructive"
      : entry.severity === "warning"
        ? "text-yellow-400"
        : "text-muted-foreground/50";

  const saveAnnotation = () => {
    updateKnowledge.mutate(
      { id: entry.id, data: { annotation: annotationDraft || null } },
      {
        onSuccess: () => {
          setShowAnnotationInput(false);
          onUpdate();
        },
      },
    );
  };

  const handleShareWithCommunity = () => {
    if (promotePending || entry.approvedForReuse) return;
    setPromotePending(true);
    promoteToGlobal.mutate(
      { id: projectId, entryId: entry.id },
      {
        onSuccess: () => {
          setPromoteSuccess(true);
          onUpdate();
        },
        onSettled: () => setPromotePending(false),
      },
    );
  };

  const handleArchive = () => {
    setShowMenu(false);
    updateKnowledge.mutate(
      { id: entry.id, data: { archived: !entry.archivedAt } },
      { onSuccess: onUpdate },
    );
  };

  // Used only for the "Remove from Global" de-promotion action (no anonymization
  // needed in that direction). The "Approve as Global Lesson" confirm path now
  // calls handleShareWithCommunity so that all promotions go through the
  // anonymization + embedding pipeline.
  const handleDemote = () => {
    setShowMenu(false);
    setShowConfirmPromote(false);
    updateKnowledge.mutate(
      { id: entry.id, data: { approvedForReuse: false } },
      { onSuccess: onUpdate },
    );
  };

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

  const showCheckbox = selectionMode || hovered;

  return (
    <div
      className={cn(
        "border rounded-lg p-3 bg-card space-y-2 transition-all",
        selected ? "border-primary/50 bg-primary/5" : "border-border",
        entry.archivedAt ? "opacity-50" : "",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-start gap-2.5">
        {/* Checkbox */}
        <button
          onClick={() => onToggleSelect(entry.id)}
          className={cn(
            "shrink-0 mt-1 transition-all",
            showCheckbox ? "opacity-100 w-5" : "opacity-0 w-0 overflow-hidden",
          )}
          title={selected ? "Deselect" : "Select"}
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-primary" />
          ) : (
            <Square className="h-4 w-4 text-muted-foreground/50 hover:text-muted-foreground" />
          )}
        </button>

        <div
          className={cn(
            "w-7 h-7 rounded-md border flex items-center justify-center shrink-0 mt-0.5",
            typeColor,
          )}
        >
          <TypeIcon className="h-3.5 w-3.5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-1.5">
            <div className="flex-1 min-w-0">
              <h3 className="text-xs font-medium text-foreground leading-snug">{entry.title}</h3>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span
                  className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium border", typeColor)}
                >
                  {getTypeLabel(entry.type)}
                </span>
                {entry.category && entry.category !== entry.type && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-border bg-muted text-muted-foreground">
                    {entry.category}
                  </span>
                )}
                {entry.approvedForReuse && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 flex items-center gap-1">
                    <Star className="h-2.5 w-2.5" />
                    Global
                  </span>
                )}
                {((entry as unknown as Record<string, number>).reinforcedCount ?? 0) > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-border bg-muted text-muted-foreground">
                    Reinforced {(entry as unknown as Record<string, number>).reinforcedCount}×
                  </span>
                )}
                <span className={cn("flex items-center gap-0.5 text-[10px]", severityColor)}>
                  <SeverityIcon className="h-2.5 w-2.5" />
                  {entry.severity}
                </span>
                <span className="text-[10px] text-muted-foreground/40 ml-auto flex items-center gap-1 shrink-0">
                  <Clock className="h-2.5 w-2.5" />
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground"
                title={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              <button
                onClick={() => {
                  setShowAnnotationInput((v) => !v);
                  setShowMenu(false);
                }}
                className={cn(
                  "w-5 h-5 flex items-center justify-center",
                  entry.annotation ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
                title={entry.annotation ? "Edit note" : "Add note"}
              >
                <MessageSquare className="h-3 w-3" />
              </button>
              {/* Share with community — only visible for entries owned by current user that aren't yet global */}
              {currentUserId && entry.userId === currentUserId && !entry.approvedForReuse && (
                <button
                  onClick={handleShareWithCommunity}
                  disabled={promotePending}
                  className={cn(
                    "w-5 h-5 flex items-center justify-center transition-colors",
                    promoteSuccess ? "text-green-400" : "text-muted-foreground hover:text-primary",
                  )}
                  title="Share with community — promotes this lesson to the global knowledge pool"
                >
                  {promotePending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Share2 className="h-3 w-3" />
                  )}
                </button>
              )}
              <div className="relative">
                <button
                  onClick={() => {
                    setShowMenu((v) => !v);
                    setShowAnnotationInput(false);
                  }}
                  className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="h-3 w-3" />
                </button>
                {showMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px]">
                    {!showConfirmPromote ? (
                      <button
                        onClick={() =>
                          entry.approvedForReuse ? handleDemote() : setShowConfirmPromote(true)
                        }
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left"
                      >
                        <Star
                          className={cn(
                            "h-3.5 w-3.5",
                            entry.approvedForReuse ? "text-yellow-400" : "text-muted-foreground",
                          )}
                        />
                        {entry.approvedForReuse ? "Remove from Global" : "Approve as Global Lesson"}
                      </button>
                    ) : (
                      <div className="px-3 py-2 space-y-2">
                        <p className="text-xs text-muted-foreground leading-snug">
                          This lesson will be used by the AI across all projects.
                        </p>
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            className="h-6 text-xs px-2"
                            onClick={() => {
                              setShowMenu(false);
                              setShowConfirmPromote(false);
                              handleShareWithCommunity();
                            }}
                            disabled={promotePending}
                          >
                            {promotePending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Confirm"
                            )}
                          </Button>
                          <button
                            onClick={() => setShowConfirmPromote(false)}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    <button
                      onClick={handleArchive}
                      disabled={updateKnowledge.isPending}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left"
                    >
                      <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                      {entry.archivedAt ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      onClick={() => setShowMenu(false)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted transition-colors"
                    >
                      <X className="h-3.5 w-3.5" /> Close
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Annotation display */}
      {entry.annotation && !showAnnotationInput && (
        <div className="text-xs text-muted-foreground bg-muted/40 border border-border/60 rounded px-2.5 py-1.5 italic ml-9">
          "{entry.annotation}"
        </div>
      )}
      {showAnnotationInput && (
        <div className="space-y-1.5 ml-9">
          <textarea
            value={annotationDraft}
            onChange={(e) => setAnnotationDraft(e.target.value)}
            placeholder="Add a personal note…"
            rows={2}
            className="w-full text-xs bg-muted border border-border rounded px-2.5 py-1.5 resize-none focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/50"
            autoFocus
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-6 text-xs px-2"
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
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="ml-9 space-y-2 pt-1.5 border-t border-border/50">
          <p className="text-xs text-muted-foreground leading-relaxed">{entry.content}</p>
          {hasDiff && (
            <div className="space-y-0.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                File changes
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
          {entry.tags && (
            <div className="flex flex-wrap gap-1">
              {entry.tags.split(",").map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground"
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

const CATEGORY_PRESETS = ["note", "api", "layout", "style", "auth", "data", "performance"];

function NewEntryForm({
  projectId,
  onSuccess,
  onCancel,
}: {
  projectId: number;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("note");
  const [severity, setSeverity] = useState<"info" | "warning" | "error">("info");
  const createKnowledge = useCreateKnowledge();

  const canSubmit =
    title.trim().length > 0 && content.trim().length > 0 && !createKnowledge.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    createKnowledge.mutate(
      {
        data: {
          title: title.trim(),
          content: content.trim(),
          category: category.trim() || "note",
          type: "note",
          severity,
          projectId,
        } as KnowledgeInput & { projectId: number },
      },
      {
        onSuccess: () => {
          onSuccess();
        },
      },
    );
  };

  return (
    <div className="border border-primary/30 rounded-lg bg-card p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">New entry</span>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Title */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (required)"
        maxLength={200}
        autoFocus
        className="w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
      />

      {/* Content */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Content — describe the lesson or note (required)"
        rows={3}
        className="w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 resize-none"
      />

      {/* Category + Severity row */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold block mb-1">
            Category
          </label>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            list="category-presets"
            placeholder="e.g. api, layout, note"
            className="w-full bg-muted border border-border rounded px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
          />
          <datalist id="category-presets">
            {CATEGORY_PRESETS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="w-28">
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold block mb-1">
            Severity
          </label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as "info" | "warning" | "error")}
            className="w-full bg-muted border border-border rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary/50"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      {createKnowledge.isError && (
        <p className="text-[10px] text-destructive">Failed to save entry. Please try again.</p>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <Button size="sm" className="h-7 text-xs px-3" onClick={handleSubmit} disabled={!canSubmit}>
          {createKnowledge.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Save entry
        </Button>
        <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function KnowledgeTab({ projectId }: { projectId: number }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [severityFilter, setSeverityFilter] = useState("");
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [showNewEntryForm, setShowNewEntryForm] = useState(false);
  const queryClient = useQueryClient();
  const updateKnowledge = useUpdateKnowledge();
  const { user } = useClerkUser();

  const params = useMemo(
    () => ({
      projectId,
      archived: showArchived,
      limit: 200,
    }),
    [projectId, showArchived],
  );

  const { data: entries = [], isLoading } = useListKnowledge(params, {
    query: {
      enabled: !!projectId,
      queryKey: getListKnowledgeQueryKey(params),
    },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getListKnowledgeQueryKey(params),
    });
  }, [queryClient, params]);

  const filtered = useMemo(() => {
    let pool = entries;
    if (approvedOnly) pool = pool.filter((e) => e.approvedForReuse);
    if (severityFilter) pool = pool.filter((e) => e.severity === severityFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      pool = pool.filter(
        (e) => e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q),
      );
    }
    return pool;
  }, [entries, approvedOnly, severityFilter, searchQuery]);

  const approvedCount = useMemo(() => entries.filter((e) => e.approvedForReuse).length, [entries]);

  const countBySeverity = useMemo(
    () => ({
      warning: entries.filter((e) => e.severity === "warning").length,
      error: entries.filter((e) => e.severity === "error").length,
    }),
    [entries],
  );

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allFilteredSelected = filtered.length > 0 && filtered.every((e) => selectedIds.has(e.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((e) => e.id)));
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const selectedCount = selectedIds.size;

  const runBulkAction = async (action: "approve" | "archive") => {
    setBulkPending(true);
    const ids = Array.from(selectedIds);
    const mutations = ids.map((id) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return Promise.resolve();
      const data =
        action === "approve" ? { approvedForReuse: true } : { archived: !entry.archivedAt };
      return new Promise<void>((resolve) => {
        updateKnowledge.mutate({ id, data }, { onSettled: () => resolve() });
      });
    });
    await Promise.all(mutations);
    setBulkPending(false);
    setSelectedIds(new Set());
    invalidate();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background relative">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-4 w-4 text-secondary" />
            <span className="text-sm font-semibold text-foreground">AI Memory</span>
            {!isLoading && entries.length > 0 && (
              <span className="text-xs text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded-full">
                {entries.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {approvedCount > 0 && !selectionMode && (
              <div className="flex items-center gap-1 text-[10px] text-yellow-400">
                <CheckCircle2 className="h-3 w-3" />
                {approvedCount} global lesson{approvedCount !== 1 ? "s" : ""}
              </div>
            )}
            <button
              onClick={() => setShowNewEntryForm((v) => !v)}
              className={cn(
                "flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border font-medium transition-colors",
                showNewEntryForm
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/30",
              )}
            >
              <Plus className="h-3 w-3" />
              New entry
            </button>
            {entries.length > 0 && (
              <button
                onClick={() => {
                  if (selectionMode) {
                    clearSelection();
                  } else {
                    setSelectionMode(true);
                  }
                }}
                className={cn(
                  "text-[10px] px-2 py-1 rounded border font-medium transition-colors",
                  selectionMode
                    ? "border-primary/40 text-primary bg-primary/10"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {selectionMode ? "Exit select" : "Select"}
              </button>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search entries…"
            className="w-full bg-muted border border-border rounded-lg pl-8 pr-8 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setApprovedOnly((v) => !v)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded-full border font-medium transition-colors flex items-center gap-1",
              approvedOnly
                ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"
                : "border-border text-muted-foreground hover:text-foreground hover:border-yellow-500/30",
            )}
          >
            <Star className="h-2.5 w-2.5" />
            Global lessons
            {approvedCount > 0 && (
              <span
                className={cn(
                  "text-[9px] px-1 rounded-full leading-none",
                  approvedOnly
                    ? "bg-yellow-500/20 text-yellow-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {approvedCount}
              </span>
            )}
          </button>
          {(["warning", "error"] as const).map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverityFilter((v) => (v === sev ? "" : sev))}
              className={cn(
                "text-[10px] px-2.5 py-1 rounded-full border font-medium transition-colors flex items-center gap-1",
                severityFilter === sev
                  ? sev === "error"
                    ? "bg-destructive/10 border-destructive/40 text-destructive"
                    : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {sev}
              {countBySeverity[sev] > 0 && (
                <span className="text-[9px] px-1 rounded-full bg-muted text-muted-foreground leading-none">
                  {countBySeverity[sev]}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded-full border font-medium transition-colors ml-auto",
              showArchived
                ? "border-primary/30 text-primary bg-primary/10"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <Archive className="inline h-2.5 w-2.5 mr-1" />
            {showArchived ? "Hide archived" : "Archived"}
          </button>
        </div>

        {/* Select-all bar */}
        {selectionMode && filtered.length > 0 && (
          <div className="flex items-center gap-2 py-0.5">
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {allFilteredSelected ? (
                <CheckSquare className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {allFilteredSelected ? "Deselect all" : `Select all (${filtered.length})`}
            </button>
            {selectedCount > 0 && (
              <span className="text-[10px] text-muted-foreground/60">
                — {selectedCount} selected
              </span>
            )}
          </div>
        )}
      </div>

      {/* Entry list */}
      <div className={cn("flex-1 overflow-y-auto p-4 space-y-2", selectedCount > 0 ? "pb-20" : "")}>
        {showNewEntryForm && (
          <NewEntryForm
            projectId={projectId}
            onSuccess={() => {
              setShowNewEntryForm(false);
              invalidate();
            }}
            onCancel={() => setShowNewEntryForm(false)}
          />
        )}
        {isLoading ? (
          <div className="flex items-center justify-center pt-12 gap-2 text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading knowledge entries…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-16 gap-3 text-center px-6">
            <div className="w-10 h-10 rounded-full border border-border bg-muted flex items-center justify-center">
              <BrainCircuit className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                {entries.length === 0
                  ? "No knowledge entries yet"
                  : "No entries match your filters"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {entries.length === 0
                  ? "Entries are created automatically after each build. You can also add your own."
                  : "Try clearing your filters."}
              </p>
            </div>
            {(approvedOnly || !!severityFilter || !!searchQuery) && (
              <button
                onClick={() => {
                  setApprovedOnly(false);
                  setSeverityFilter("");
                  setSearchQuery("");
                }}
                className="text-xs text-primary hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="text-[10px] text-muted-foreground/50 pb-1">
              {filtered.length} entr{filtered.length !== 1 ? "ies" : "y"}
              {(approvedOnly || !!severityFilter || !!searchQuery) &&
                ` — filtered from ${entries.length}`}
            </p>
            {filtered.map((entry) => (
              <KnowledgeEntryCard
                key={entry.id}
                entry={entry}
                onUpdate={invalidate}
                selectionMode={selectionMode}
                selected={selectedIds.has(entry.id)}
                onToggleSelect={toggleSelect}
                currentUserId={user?.id}
                projectId={projectId}
              />
            ))}
          </>
        )}
      </div>

      {/* Footer hint */}
      {!isLoading && entries.length > 0 && selectedCount === 0 && (
        <div className="shrink-0 px-4 py-2 border-t border-border/50 bg-muted/20">
          <p className="text-[10px] text-muted-foreground/50 leading-relaxed">
            Entries marked as <span className="text-yellow-400 font-medium">Global Lessons</span>{" "}
            are injected into every AI build across all projects with a 1.5× priority boost.
          </p>
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectedCount > 0 && (
        <div className="absolute bottom-0 left-0 right-0 z-20 px-4 py-3 border-t border-border bg-card/95 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">{selectedCount} selected</span>
            <div className="flex-1 flex items-center gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5 border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                disabled={bulkPending}
                onClick={() => runBulkAction("approve")}
              >
                {bulkPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Star className="h-3 w-3" />
                )}
                Approve ({selectedCount})
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                disabled={bulkPending}
                onClick={() => runBulkAction("archive")}
              >
                {bulkPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Archive className="h-3 w-3" />
                )}
                Archive ({selectedCount})
              </Button>
              <button
                onClick={clearSelection}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Clear selection"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
