import { useState, useMemo } from "react";
import {
  useListKnowledge,
  useListProjects,
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
  Star,
  Archive,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Clock,
  MoreHorizontal,
  FolderOpen,
} from "lucide-react";

function getTypeIcon(type: string) {
  switch (type) {
    case "build": return Hammer;
    case "refine": return RefreshCw;
    case "rollback": return RotateCcw;
    case "publish":
    case "publish_failed": return Globe;
    case "secret_change": return KeyRound;
    case "manual_edit": return FilePen;
    case "secret_warning":
    case "integration_needed": return FileWarning;
    default: return NotebookPen;
  }
}

function getTypeColor(type: string, severity: string) {
  if (severity === "error") return "text-destructive border-destructive/40 bg-destructive/10";
  if (severity === "warning") return "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
  switch (type) {
    case "build": return "text-primary border-primary/40 bg-primary/10";
    case "refine": return "text-blue-400 border-blue-500/40 bg-blue-500/10";
    case "rollback": return "text-orange-400 border-orange-500/40 bg-orange-500/10";
    case "publish": return "text-green-400 border-green-500/40 bg-green-500/10";
    case "publish_failed": return "text-destructive border-destructive/40 bg-destructive/10";
    case "secret_change": return "text-purple-400 border-purple-500/40 bg-purple-500/10";
    case "manual_edit": return "text-cyan-400 border-cyan-500/40 bg-cyan-500/10";
    default: return "text-muted-foreground border-border bg-muted/40";
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

const FILTER_OPTIONS = [
  { label: "All", value: "" },
  { label: "Builds", value: "build" },
  { label: "Refines", value: "refine" },
  { label: "Errors", value: "error" },
  { label: "Publishes", value: "publish" },
  { label: "Secrets", value: "secret_change" },
];

function KnowledgeCard({ entry, onUpdate }: { entry: KnowledgeEntry; onUpdate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [showAnnotationInput, setShowAnnotationInput] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState(entry.annotation ?? "");
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showConfirmPromote, setShowConfirmPromote] = useState(false);
  const updateKnowledge = useUpdateKnowledge();

  const TypeIcon = getTypeIcon(entry.type);
  const typeColor = getTypeColor(entry.type, entry.severity);
  const SeverityIcon = entry.severity === "error" ? AlertTriangle : entry.severity === "warning" ? AlertTriangle : Info;
  const severityColor = entry.severity === "error" ? "text-destructive" : entry.severity === "warning" ? "text-yellow-400" : "text-muted-foreground/60";

  const saveAnnotation = () => {
    updateKnowledge.mutate(
      { id: entry.id, data: { annotation: annotationDraft || null } },
      { onSuccess: () => { setShowAnnotationInput(false); onUpdate(); } },
    );
  };

  const handleArchive = () => {
    setShowContextMenu(false);
    updateKnowledge.mutate(
      { id: entry.id, data: { archived: !entry.archivedAt } },
      { onSuccess: onUpdate },
    );
  };

  const handlePromote = () => {
    setShowContextMenu(false);
    setShowConfirmPromote(false);
    updateKnowledge.mutate(
      { id: entry.id, data: { approvedForReuse: !entry.approvedForReuse } },
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

  const hasDiff = diffSummary && (
    (diffSummary.filesAdded?.length ?? 0) +
    (diffSummary.filesModified?.length ?? 0) +
    (diffSummary.filesRemoved?.length ?? 0) > 0
  );

  return (
    <div className={cn(
      "border border-border rounded-lg p-4 bg-card space-y-2 transition-opacity",
      entry.archivedAt ? "opacity-50" : "",
    )}>
      <div className="flex items-start gap-3">
        <div className={cn("w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 mt-0.5", typeColor)}>
          <TypeIcon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium text-foreground leading-snug">{entry.title}</h3>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium border", typeColor)}>
                  {getTypeLabel(entry.type)}
                </span>
                {entry.approvedForReuse && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 flex items-center gap-1">
                    <Star className="h-2.5 w-2.5" /> Global Lesson
                  </span>
                )}
                <span className={cn("flex items-center gap-0.5 text-[10px]", severityColor)}>
                  <SeverityIcon className="h-3 w-3" />
                  {entry.severity}
                </span>
                <span className="text-[10px] text-muted-foreground/50 ml-auto flex items-center gap-1 shrink-0">
                  <Clock className="h-2.5 w-2.5" />
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  })}
                </span>
              </div>
            </div>
            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => { setShowAnnotationInput((v) => !v); setShowContextMenu(false); }}
                className={cn("w-6 h-6 flex items-center justify-center", entry.annotation ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                title={entry.annotation ? "Edit note" : "Add note"}
              >
                <MessageSquare className="h-3.5 w-3.5" />
              </button>
              <div className="relative">
                <button
                  onClick={() => { setShowContextMenu((v) => !v); setShowAnnotationInput(false); }}
                  className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
                {showContextMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[170px]">
                    {!showConfirmPromote ? (
                      <button
                        onClick={() => entry.approvedForReuse ? handlePromote() : setShowConfirmPromote(true)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted transition-colors"
                      >
                        <Star className="h-3.5 w-3.5 text-yellow-400" />
                        {entry.approvedForReuse ? "Remove from Global" : "Promote to Global"}
                      </button>
                    ) : (
                      <div className="px-3 py-2 space-y-2">
                        <p className="text-xs text-muted-foreground leading-snug">
                          This lesson will be visible to the AI across all projects.
                        </p>
                        <div className="flex gap-1.5">
                          <Button size="sm" className="h-6 text-xs px-2" onClick={handlePromote}>Confirm</Button>
                          <button onClick={() => setShowConfirmPromote(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                        </div>
                      </div>
                    )}
                    <button
                      onClick={handleArchive}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted transition-colors"
                    >
                      <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                      {entry.archivedAt ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      onClick={() => setShowContextMenu(false)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted transition-colors"
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

      {/* Annotation */}
      {entry.annotation && !showAnnotationInput && (
        <div className="text-xs text-muted-foreground bg-muted/40 border border-border/60 rounded px-3 py-1.5 italic ml-11">
          "{entry.annotation}"
        </div>
      )}
      {showAnnotationInput && (
        <div className="space-y-1.5 ml-11">
          <textarea
            value={annotationDraft}
            onChange={(e) => setAnnotationDraft(e.target.value)}
            placeholder="Add a personal note…"
            rows={2}
            className="w-full text-sm bg-muted border border-border rounded px-3 py-1.5 resize-none focus:outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground/50"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 text-xs px-2" onClick={saveAnnotation} disabled={updateKnowledge.isPending}>Save</Button>
            <button onClick={() => { setShowAnnotationInput(false); setAnnotationDraft(entry.annotation ?? ""); }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="ml-11 space-y-2 pt-1 border-t border-border/50">
          <p className="text-sm text-muted-foreground leading-relaxed">{entry.content}</p>

          {/* Diff summary */}
          {hasDiff && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-3 mb-1">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">File changes</div>
                {((diffSummary?.linesAdded ?? 0) > 0 || (diffSummary?.linesRemoved ?? 0) > 0) && (
                  <div className="flex gap-2 text-[10px]">
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
                <div key={`a-${f}`} className="font-mono text-xs text-green-400 flex items-center gap-1">
                  <span className="shrink-0">+</span><span className="truncate">{f}</span>
                </div>
              ))}
              {(diffSummary?.filesModified ?? []).map((f) => (
                <div key={`m-${f}`} className="font-mono text-xs text-yellow-400 flex items-center gap-1">
                  <span className="shrink-0">~</span><span className="truncate">{f}</span>
                </div>
              ))}
              {(diffSummary?.filesRemoved ?? []).map((f) => (
                <div key={`r-${f}`} className="font-mono text-xs text-red-400/70 flex items-center gap-1">
                  <span className="shrink-0">-</span><span className="truncate">{f}</span>
                </div>
              ))}
            </div>
          )}

          {entry.tags && (
            <div className="flex flex-wrap gap-1">
              {entry.tags.split(",").map((tag) => (
                <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground">{tag.trim()}</span>
              ))}
            </div>
          )}
          {entry.relatedVersionId && (
            <div className="text-xs text-muted-foreground/60">Snapshot version #{entry.relatedVersionId}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function KnowledgePage() {
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const queryClient = useQueryClient();

  const { data: projects = [] } = useListProjects();

  // All entries for the current user's projects (+ global). Server-side project scoping.
  const allEntriesParams = {
    archived: showArchived,
    limit: 200,
  };
  const { data: allEntries = [], isLoading: isLoadingAll } = useListKnowledge(
    allEntriesParams,
    { query: { queryKey: getListKnowledgeQueryKey(allEntriesParams) } },
  );

  // Project-specific fetch (when a project is selected)
  const projectParams = {
    projectId: selectedProjectId ?? undefined,
    archived: showArchived,
    limit: 200,
  };
  const { data: projectEntries = [], isLoading: isLoadingProject } = useListKnowledge(
    projectParams,
    {
      query: {
        enabled: selectedProjectId !== null,
        queryKey: getListKnowledgeQueryKey(projectParams),
      },
    },
  );

  const isLoading = isLoadingAll || (selectedProjectId !== null && isLoadingProject);

  // Apply search + type filter
  const filterEntries = (entries: KnowledgeEntry[]) =>
    entries.filter((e) => {
      if (typeFilter === "error" && e.severity !== "error") return false;
      if (typeFilter && typeFilter !== "error" && e.type !== typeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q);
      }
      return true;
    });

  // Global lessons from all entries
  const filteredGlobal = filterEntries(allEntries.filter((e) => e.approvedForReuse));

  // Project history: either filtered by selected project, or grouped by project across all
  const baseProjectHistory = selectedProjectId !== null
    ? projectEntries.filter((e) => !e.approvedForReuse && e.projectId === selectedProjectId)
    : allEntries.filter((e) => !e.approvedForReuse && e.projectId !== null);
  const filteredProjectHistory = filterEntries(baseProjectHistory);

  // Group by project when no specific project is selected
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const groupedByProject = useMemo(() => {
    if (selectedProjectId !== null) return null;
    const groups = new Map<number, { projectName: string; entries: KnowledgeEntry[] }>();
    for (const e of filteredProjectHistory) {
      if (e.projectId === null || e.projectId === undefined) continue;
      const pid = e.projectId as number;
      const existing = groups.get(pid);
      const projectName = projectMap.get(pid) ?? `Project #${pid}`;
      if (existing) {
        existing.entries.push(e);
      } else {
        groups.set(pid, { projectName, entries: [e] });
      }
    }
    return Array.from(groups.values());
  }, [filteredProjectHistory, selectedProjectId, projectMap]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey(allEntriesParams) });
    if (selectedProjectId !== null) {
      void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey(projectParams) });
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Knowledge Vault</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Per-project history, global lessons, and curated learnings for the AI builder.
        </p>
      </div>

      {/* Controls */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={selectedProjectId ?? ""}
            onChange={(e) => setSelectedProjectId(e.target.value ? parseInt(e.target.value, 10) : null)}
            className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary/50 min-w-[200px]"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search entries…"
              className="w-full bg-card border border-border rounded-lg pl-9 pr-9 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={cn(
              "text-sm px-3 py-2 rounded-lg border transition-colors",
              showArchived
                ? "border-primary/30 text-primary bg-primary/10"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        </div>
        <div className="flex gap-2 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTypeFilter(opt.value === typeFilter ? "" : opt.value)}
              className={cn(
                "text-xs px-3 py-1 rounded-full border font-medium transition-colors",
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

      {/* Global Lessons */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-yellow-400" />
          <h2 className="text-lg font-semibold">Global Lessons</h2>
          <span className="text-xs text-muted-foreground ml-1">({filteredGlobal.length})</span>
          <p className="text-xs text-muted-foreground ml-2">— Approved for reuse across all projects</p>
        </div>
        {isLoading ? (
          <div className="border border-border rounded-lg p-6 text-center text-muted-foreground text-sm bg-muted/20">
            Loading…
          </div>
        ) : filteredGlobal.length === 0 ? (
          <div className="border border-border rounded-lg p-6 text-center text-muted-foreground text-sm bg-muted/20">
            No global lessons yet. Promote an entry to make it available to the AI across all projects.
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredGlobal.map((entry) => (
              <KnowledgeCard key={entry.id} entry={entry} onUpdate={invalidate} />
            ))}
          </div>
        )}
      </section>

      {/* Project History */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">
            Project History
            {selectedProject && (
              <span className="text-muted-foreground font-normal text-base ml-2">
                — {selectedProject.name}
              </span>
            )}
          </h2>
          <span className="text-xs text-muted-foreground ml-1">({filteredProjectHistory.length})</span>
        </div>

        {isLoading ? (
          <div className="border border-border rounded-lg p-6 text-center text-muted-foreground text-sm bg-muted/20">Loading…</div>
        ) : filteredProjectHistory.length === 0 ? (
          <div className="border border-border rounded-lg p-6 text-center text-muted-foreground text-sm bg-muted/20">
            {selectedProjectId !== null
              ? "No history entries for this project yet."
              : "No project history yet. History is recorded automatically as you build."}
          </div>
        ) : selectedProjectId !== null ? (
          // Single project: flat list
          <div className="grid gap-3">
            {filteredProjectHistory.map((entry) => (
              <KnowledgeCard key={entry.id} entry={entry} onUpdate={invalidate} />
            ))}
          </div>
        ) : (
          // All projects: grouped by project
          <div className="space-y-6">
            {(groupedByProject ?? []).map(({ projectName, entries }) => (
              <div key={projectName} className="space-y-3">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
                  <span className="text-sm font-medium text-muted-foreground">{projectName}</span>
                  <span className="text-xs text-muted-foreground/50">({entries.length})</span>
                </div>
                <div className="grid gap-2 pl-5 border-l border-border/40">
                  {entries.map((entry) => (
                    <KnowledgeCard key={entry.id} entry={entry} onUpdate={invalidate} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
