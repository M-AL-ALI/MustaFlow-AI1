import { authFetch } from "@/lib/api-fetch";
import { useState, useMemo } from "react";
import {
  useListPublicKnowledge,
  getListPublicKnowledgeQueryKey,
} from "@workspace/api-client-react";
import type { KnowledgeEntry } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/app-layout";
import { cn } from "@/lib/utils";
import {
  Globe,
  ThumbsUp,
  ThumbsDown,
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  BookOpen,
  Hammer,
  RefreshCw,
  RotateCcw,
  KeyRound,
  FilePen,
  FileWarning,
  NotebookPen,
  BrainCircuit,
  Layers,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const CATEGORY_FILTERS = [
  { label: "All", value: "" },
  { label: "Build", value: "build" },
  { label: "Refine", value: "refine" },
  { label: "Style", value: "style" },
  { label: "Auth", value: "auth" },
  { label: "API", value: "api" },
  { label: "Data", value: "data" },
  { label: "Layout", value: "layout" },
  { label: "Performance", value: "performance" },
];

function getTypeIcon(type: string) {
  switch (type) {
    case "build":
      return Hammer;
    case "refine":
      return RefreshCw;
    case "rollback":
      return RotateCcw;
    case "secret_change":
      return KeyRound;
    case "manual_edit":
      return FilePen;
    case "secret_warning":
    case "integration_needed":
      return FileWarning;
    case "style_memory":
      return BrainCircuit;
    case "note":
      return NotebookPen;
    default:
      return Layers;
  }
}

function PublicLessonCard({ entry }: { entry: KnowledgeEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [ratedUp, setRatedUp] = useState(false);
  const [ratedDown, setRatedDown] = useState(false);
  const { toast } = useToast();

  const TypeIcon = getTypeIcon(entry.type);

  const handleRate = async (direction: "up" | "down") => {
    if (ratedUp || ratedDown) return;
    try {
      const res = await authFetch(`/api/knowledge/${entry.id}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: direction }),
      });
      if (direction === "up") setRatedUp(true);
      else setRatedDown(true);
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          contributorRewardGranted?: boolean;
          contributorRewardCredits?: number;
        } | null;
        if (data?.contributorRewardGranted && (data.contributorRewardCredits ?? 0) > 0) {
          toast({
            title: "Your rating earned the contributor a reward",
            description: `This lesson crossed the helpful-rating threshold — its author was granted ${data.contributorRewardCredits} credits.`,
          });
        }
      }
    } catch {
      toast({ title: "Failed to rate lesson", variant: "destructive" });
    }
  };

  const upCount = (entry.thumbsUp ?? 0) + (ratedUp ? 1 : 0);
  const downCount = (entry.thumbsDown ?? 0) + (ratedDown ? 1 : 0);
  const netScore = upCount - downCount;

  return (
    <div className="border border-border rounded-lg p-4 bg-card hover:border-border/80 transition-colors">
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-md bg-muted border border-border flex items-center justify-center shrink-0 mt-0.5">
          <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <h3 className="text-sm font-medium text-foreground leading-snug">{entry.title}</h3>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-semibold border",
                    netScore >= 5
                      ? "bg-green-500/15 border-green-500/30 text-green-400"
                      : netScore > 0
                        ? "bg-muted border-border text-foreground"
                        : netScore < 0
                          ? "bg-red-500/10 border-red-500/20 text-red-400/80"
                          : "bg-muted border-border text-muted-foreground",
                  )}
                  title={`${upCount} thumbs up, ${downCount} thumbs down`}
                >
                  <ThumbsUp className="h-2.5 w-2.5" />
                  {netScore > 0 ? `+${netScore}` : netScore}
                </span>
                {entry.category && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-border bg-muted text-muted-foreground">
                    {entry.category}
                  </span>
                )}
                {entry.tags &&
                  entry.tags
                    .split(",")
                    .slice(0, 3)
                    .map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/70 border border-border/60 text-muted-foreground/70"
                      >
                        {tag.trim()}
                      </span>
                    ))}
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => void handleRate("up")}
                className={cn(
                  "flex items-center gap-1 px-1.5 py-1 rounded text-[10px] transition-colors",
                  ratedUp
                    ? "bg-green-500/15 text-green-400 border border-green-500/30"
                    : "text-muted-foreground hover:text-green-400 hover:bg-green-500/10 border border-transparent",
                )}
              >
                <ThumbsUp className="h-3 w-3" />
                <span>{upCount}</span>
              </button>
              <button
                onClick={() => void handleRate("down")}
                className={cn(
                  "flex items-center gap-1 px-1.5 py-1 rounded text-[10px] transition-colors",
                  ratedDown
                    ? "bg-red-500/15 text-red-400 border border-red-500/30"
                    : "text-muted-foreground hover:text-red-400 hover:bg-red-500/10 border border-transparent",
                )}
              >
                <ThumbsDown className="h-3 w-3" />
                <span>{downCount}</span>
              </button>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          {expanded && (
            <p className="mt-2.5 text-xs text-muted-foreground leading-relaxed border-t border-border/50 pt-2.5">
              {entry.content}
            </p>
          )}

          {(entry.usageCount ?? 0) > 0 && (
            <div className="mt-2 text-[10px] text-muted-foreground/50">
              Used {entry.usageCount} time{entry.usageCount !== 1 ? "s" : ""} by the AI
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LibraryPage() {
  const [categoryFilter, setCategoryFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const params = {
    ...(categoryFilter ? { category: categoryFilter } : {}),
    limit: 100,
  };

  const { data: entries = [], isLoading } = useListPublicKnowledge(params, {
    query: {
      queryKey: getListPublicKnowledgeQueryKey(params),
    },
  });

  const filtered = useMemo(() => {
    if (!searchQuery) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        (e.category ?? "").toLowerCase().includes(q),
    );
  }, [entries, searchQuery]);

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          {/* Header */}
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <Globe className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Public Library</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Community-shared lessons approved for reuse
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground/70 mb-6 ml-13 pl-1">
            These lessons were contributed by NabuFlow users and are anonymized. Helpful ratings
            surface the best lessons.
          </p>

          {/* Search + filter */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search lessons…"
                className="w-full pl-8 pr-3 py-2 bg-muted border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>

          {/* Category pills */}
          <div className="flex flex-wrap gap-1.5 mb-6">
            {CATEGORY_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setCategoryFilter(f.value)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                  categoryFilter === f.value
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-muted border-border text-muted-foreground hover:border-primary/30 hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="border border-dashed border-border rounded-xl p-10 text-center">
              <BookOpen className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No public lessons yet</p>
              <p className="text-xs text-muted-foreground/60 max-w-sm mx-auto mt-1 leading-relaxed">
                Be the first to contribute — approve a lesson in your Knowledge Vault and enable
                "Share publicly" to add it here.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {filtered.length} lesson{filtered.length !== 1 ? "s" : ""} in the public library
                </span>
              </div>
              <div className="space-y-2">
                {filtered.map((entry) => (
                  <PublicLessonCard key={entry.id} entry={entry} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
