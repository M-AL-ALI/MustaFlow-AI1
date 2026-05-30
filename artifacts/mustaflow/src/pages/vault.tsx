import { useState, useCallback, useMemo } from "react";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FilePen,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Tag,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { VaultSaveDialog } from "@/components/vault-save-dialog";

interface VaultEntry {
  id: number;
  userId: string;
  title: string;
  category: string;
  subcategory?: string | null;
  summary: string;
  content: string;
  tags?: string | null;
  department?: string | null;
  sourceType: string;
  sourceReference?: string | null;
  status: string;
  version: number;
  confidenceScore?: number | null;
  approved: boolean;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

interface VaultVersion {
  id: number;
  entryId: number;
  version: number;
  title: string;
  summary: string;
  content: string;
  tags?: string | null;
  department?: string | null;
  editedBy: string;
  editedAt: string;
  changeSummary?: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  ALL: "All",
  REPORT: "Reports",
  INVESTIGATION: "Investigations",
  CORRECTIVE_ACTION: "Corrective Actions",
  LESSON_LEARNED: "Lessons Learned",
  BEST_PRACTICE: "Best Practices",
  PROJECT: "Projects",
  SOP: "SOPs",
  STANDARD: "Standards",
  AUDIT: "Audits",
  KPI: "KPIs",
  RISK: "Risks",
  OTHER: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  REPORT: "text-blue-400 border-blue-500/40 bg-blue-500/10",
  INVESTIGATION: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  CORRECTIVE_ACTION: "text-red-400 border-red-500/40 bg-red-500/10",
  LESSON_LEARNED: "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  BEST_PRACTICE: "text-green-400 border-green-500/40 bg-green-500/10",
  PROJECT: "text-purple-400 border-purple-500/40 bg-purple-500/10",
  SOP: "text-cyan-400 border-cyan-500/40 bg-cyan-500/10",
  STANDARD: "text-teal-400 border-teal-500/40 bg-teal-500/10",
  AUDIT: "text-pink-400 border-pink-500/40 bg-pink-500/10",
  KPI: "text-indigo-400 border-indigo-500/40 bg-indigo-500/10",
  RISK: "text-rose-400 border-rose-500/40 bg-rose-500/10",
  OTHER: "text-muted-foreground border-border bg-muted/40",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  archived: "Archived",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "text-muted-foreground",
  approved: "text-green-400",
  archived: "text-muted-foreground/50",
};

function useTags(entry: VaultEntry): string[] {
  return (entry.tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function CategoryBadge({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS["OTHER"];
  const label = CATEGORY_LABELS[category] ?? category;
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", color)}>
      {label}
    </span>
  );
}

function EntryCard({ entry, onClick }: { entry: VaultEntry; onClick: (e: VaultEntry) => void }) {
  const tags = useTags(entry);
  return (
    <button
      onClick={() => onClick(entry)}
      className={cn(
        "w-full text-left border border-border rounded-lg p-4 bg-card hover:border-primary/40 transition-colors space-y-2",
        entry.archivedAt ? "opacity-50" : "",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground leading-snug truncate">
            {entry.title}
          </h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <CategoryBadge category={entry.category} />
            {entry.department && (
              <span className="text-[10px] text-muted-foreground">{entry.department}</span>
            )}
            <span className={cn("text-[10px] font-medium", STATUS_COLORS[entry.status])}>
              {STATUS_LABELS[entry.status] ?? entry.status}
            </span>
            {entry.approved && (
              <span className="text-[10px] text-green-400 flex items-center gap-0.5">
                <CheckCircle className="h-2.5 w-2.5" /> Approved
              </span>
            )}
            <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0 flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {new Date(entry.updatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </div>
        <span className="text-[9px] text-muted-foreground/50 shrink-0 pt-0.5">
          v{entry.version}
        </span>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{entry.summary}</p>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 5).map((t) => (
            <span
              key={t}
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground flex items-center gap-1"
            >
              <Tag className="h-2 w-2" />
              {t}
            </span>
          ))}
          {tags.length > 5 && (
            <span className="text-[10px] text-muted-foreground/50">+{tags.length - 5}</span>
          )}
        </div>
      )}
    </button>
  );
}

function EntryViewer({
  entry,
  onClose,
  onUpdated,
}: {
  entry: VaultEntry;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [editTitle, setEditTitle] = useState(entry.title);
  const [editSummary, setEditSummary] = useState(entry.summary);
  const [editContent, setEditContent] = useState(entry.content);
  const [editTags, setEditTags] = useState(
    (entry.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .join(", "),
  );
  const [saving, setSaving] = useState(false);

  const { data: versions } = useQuery<VaultVersion[]>({
    queryKey: ["vault-versions", entry.id],
    queryFn: async () => {
      const res = await fetch(`/api/vault/${entry.id}/versions`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load versions");
      return res.json() as Promise<VaultVersion[]>;
    },
    enabled: showVersions,
  });

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      const tags = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await fetch(`/api/vault/${entry.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          summary: editSummary.trim(),
          content: editContent.trim(),
          tags,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(err.detail ?? err.error ?? `Save failed (${res.status})`);
      }
      toast({ title: "Entry updated" });
      setEditing(false);
      onUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    try {
      await fetch(`/api/vault/${entry.id}/archive`, {
        method: "POST",
        credentials: "include",
      });
      toast({ title: "Entry archived" });
      onClose();
      onUpdated();
    } catch {
      toast({ title: "Failed to archive", variant: "destructive" });
    }
  };

  const handleRestore = async () => {
    try {
      await fetch(`/api/vault/${entry.id}/restore`, {
        method: "POST",
        credentials: "include",
      });
      toast({ title: "Entry restored" });
      onUpdated();
    } catch {
      toast({ title: "Failed to restore", variant: "destructive" });
    }
  };

  const tags = useTags(entry);

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2 mb-1">
            <CategoryBadge category={entry.category} />
            {entry.department && (
              <span className="text-xs text-muted-foreground">{entry.department}</span>
            )}
            <span className={cn("text-xs font-medium ml-auto", STATUS_COLORS[entry.status])}>
              {STATUS_LABELS[entry.status] ?? entry.status}
            </span>
            <span className="text-xs text-muted-foreground/50">v{entry.version}</span>
          </div>
          <SheetTitle className="text-base leading-snug">{entry.title}</SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground leading-relaxed">
            {entry.summary}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Metadata row */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-muted-foreground/60">Source</span>
              <p className="text-foreground">{entry.sourceType.replace(/_/g, " ")}</p>
            </div>
            {entry.subcategory && (
              <div>
                <span className="text-muted-foreground/60">Subcategory</span>
                <p className="text-foreground">{entry.subcategory}</p>
              </div>
            )}
            {entry.confidenceScore != null && (
              <div>
                <span className="text-muted-foreground/60">Confidence</span>
                <p className="text-foreground">{entry.confidenceScore}%</p>
              </div>
            )}
            <div>
              <span className="text-muted-foreground/60">Created</span>
              <p className="text-foreground">
                {new Date(entry.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground/60">Last updated</span>
              <p className="text-foreground">
                {new Date(entry.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <span
                  key={t}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-muted border border-border/60 text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {/* Content */}
          {!editing ? (
            <div className="bg-muted/40 border border-border rounded-lg p-4">
              <pre className="text-xs text-foreground/90 whitespace-pre-wrap font-sans leading-relaxed">
                {entry.content}
              </pre>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Title</label>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full text-sm bg-muted border border-border rounded px-3 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Summary</label>
                <textarea
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  rows={2}
                  className="w-full text-sm bg-muted border border-border rounded px-3 py-1.5 text-foreground resize-none focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Content</label>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={10}
                  className="w-full text-xs font-mono bg-muted border border-border rounded px-3 py-1.5 text-foreground resize-y focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Tags</label>
                <input
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="comma-separated"
                  className="w-full text-sm bg-muted border border-border rounded px-3 py-1.5 text-foreground focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveEdit} disabled={saving}>
                  {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save changes
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Version history */}
          <div>
            <button
              onClick={() => setShowVersions((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showVersions ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Version history
            </button>
            {showVersions && (
              <div className="mt-2 space-y-1.5">
                {!versions ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </div>
                ) : versions.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">No versions recorded.</p>
                ) : (
                  versions.map((v) => (
                    <div
                      key={v.id}
                      className="flex items-start gap-2 text-xs border border-border/60 rounded px-3 py-2 bg-muted/30"
                    >
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0 pt-0.5">
                        v{v.version}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-foreground/80 truncate">{v.title}</p>
                        {v.changeSummary && (
                          <p className="text-muted-foreground/60 text-[10px]">{v.changeSummary}</p>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground/50 shrink-0">
                        {new Date(v.editedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="border-t border-border px-6 py-3 flex items-center gap-2">
          {!entry.archivedAt ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing((v) => !v)}
                disabled={saving}
              >
                <FilePen className="h-3.5 w-3.5 mr-1.5" />
                {editing ? "Cancel edit" : "Edit"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={handleArchive}
              >
                <Archive className="h-3.5 w-3.5 mr-1.5" />
                Archive
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={handleRestore}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              Restore
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            Back
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function VaultPage() {
  const queryClient = useQueryClient();
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<VaultEntry | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const queryKey = useMemo(
    () => ["vault", { categoryFilter, statusFilter, showArchived, search }],
    [categoryFilter, statusFilter, showArchived, search],
  );

  const { data, isLoading, refetch } = useQuery<{ entries: VaultEntry[]; total: number }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (categoryFilter !== "ALL") params.set("category", categoryFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (showArchived) params.set("archived", "true");
      if (search) params.set("q", search);
      params.set("limit", "100");
      const res = await fetch(`/api/vault?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load vault");
      return res.json() as Promise<{ entries: VaultEntry[]; total: number }>;
    },
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;

  const handleSearch = useCallback(() => {
    setSearch(searchInput.trim());
  }, [searchInput]);

  const handleInvalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["vault"] });
    void refetch();
  }, [queryClient, refetch]);

  const handleEntryUpdated = useCallback(() => {
    handleInvalidate();
    if (selectedEntry) {
      void queryClient
        .fetchQuery<{ entries: VaultEntry[]; total: number }>({ queryKey })
        .then((d) => {
          const updated = d.entries.find((e) => e.id === selectedEntry.id);
          if (updated) setSelectedEntry(updated);
          else setSelectedEntry(null);
        });
    }
  }, [handleInvalidate, selectedEntry, queryClient, queryKey]);

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
              <BookOpen className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground">Knowledge Vault</h1>
              <p className="text-xs text-muted-foreground">
                Approved organizational knowledge, SOPs, lessons learned, and reports
              </p>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            New entry
          </Button>
        </div>

        {/* Search + filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search title, summary, or tags…"
              className="pl-9 pr-8"
            />
            {searchInput && (
              <button
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={handleSearch}>
            Search
          </Button>
        </div>

        {/* Category pills */}
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setCategoryFilter(val)}
              className={cn(
                "text-xs px-3 py-1 rounded-full border font-medium transition-colors",
                categoryFilter === val
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/30",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Status + archived filters */}
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
            </SelectContent>
          </Select>

          <button
            onClick={() => setShowArchived((v) => !v)}
            className={cn(
              "text-xs px-3 py-1 rounded-full border transition-colors",
              showArchived
                ? "bg-muted border-border text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>

          {total > 0 && (
            <span className="text-xs text-muted-foreground/60 ml-auto">
              {total} entr{total === 1 ? "y" : "ies"}
            </span>
          )}
        </div>

        {/* Entry grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground space-y-3">
            <BookOpen className="h-10 w-10 mx-auto opacity-30" />
            <div>
              <p className="text-sm font-medium">No entries yet</p>
              <p className="text-xs mt-1">
                Save a report, lesson learned, or SOP to start building your vault.
              </p>
            </div>
            <Button size="sm" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Create your first entry
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {entries.map((entry) => (
              <EntryCard key={entry.id} entry={entry} onClick={setSelectedEntry} />
            ))}
          </div>
        )}
      </div>

      {/* Entry viewer sheet */}
      {selectedEntry && (
        <EntryViewer
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onUpdated={handleEntryUpdated}
        />
      )}

      {/* Create dialog */}
      <VaultSaveDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        defaults={{ sourceType: "USER_CREATED" }}
        onSaved={() => {
          handleInvalidate();
        }}
      />
    </AppLayout>
  );
}
