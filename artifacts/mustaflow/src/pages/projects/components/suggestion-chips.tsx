import { useState, useEffect } from "react";
import {
  useListSuggestions,
  useAcceptSuggestion,
  useSaveSuggestion,
  useDismissSuggestion,
  getListSuggestionsQueryKey,
  type ProjectSuggestion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  Lightbulb,
  Wrench,
  Star,
  Zap,
  Bookmark,
  BookmarkCheck,
  X,
  Play,
  ChevronDown,
} from "lucide-react";

const CATEGORY_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  feature: { label: "Feature", icon: Zap, color: "text-primary" },
  fix: { label: "Fix", icon: Wrench, color: "text-yellow-400" },
  improvement: { label: "Improve", icon: Star, color: "text-blue-400" },
  idea: { label: "Idea", icon: Lightbulb, color: "text-purple-400" },
};

interface SuggestionChipsProps {
  projectId: number;
  taskId: number;
  onAccepted?: (taskId: number) => void;
}

export function SuggestionChips({ projectId, taskId, onAccepted }: SuggestionChipsProps) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  // Show a loading shimmer while suggestions are being generated async (up to 45s)
  const [generationTimedOut, setGenerationTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGenerationTimedOut(true), 45000);
    return () => clearTimeout(t);
  }, []);

  const { data: suggestions } = useListSuggestions(
    projectId,
    { taskId },
    {
      query: {
        queryKey: getListSuggestionsQueryKey(projectId, { taskId }),
        refetchInterval: (query) => {
          const data = query.state.data;
          // Poll every 4s until we have at least one suggestion (up to ~40s)
          if (!data || data.length === 0) return 4000;
          return false;
        },
        refetchIntervalInBackground: false,
        staleTime: 30000,
      },
    },
  );

  const accept = useAcceptSuggestion({
    mutation: {
      onSuccess: (data) => {
        void queryClient.invalidateQueries({
          queryKey: getListSuggestionsQueryKey(projectId, { taskId }),
        });
        if (data.taskId && onAccepted) {
          onAccepted(data.taskId);
        }
      },
    },
  });

  const save = useSaveSuggestion({
    mutation: {
      onSuccess: (data) => {
        setSaved((s) => new Set([...s, data.id]));
        void queryClient.invalidateQueries({
          queryKey: getListSuggestionsQueryKey(projectId, { taskId }),
        });
      },
    },
  });

  const dismiss = useDismissSuggestion({
    mutation: {
      onSuccess: (data) => {
        setDismissed((s) => new Set([...s, data.id]));
      },
    },
  });

  const visible = (suggestions ?? []).filter(
    (s: ProjectSuggestion) =>
      s.status !== "dismissed" &&
      s.status !== "accepted" &&
      !dismissed.has(s.id),
  );

  const isGenerating = !generationTimedOut && visible.length === 0;

  if (visible.length === 0 && !isGenerating) return null;

  if (isGenerating) {
    return (
      <div className="mt-2.5 flex items-center gap-2 text-[10px] text-muted-foreground/50">
        <div className="h-2.5 w-2.5 animate-spin rounded-full border border-muted-foreground/30 border-t-muted-foreground/60" />
        <span>Generating ideas…</span>
      </div>
    );
  }

  return (
    <div className="mt-2.5 space-y-1.5">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider hover:text-muted-foreground transition-colors w-full"
      >
        <Lightbulb className="h-3 w-3" />
        <span>Next steps</span>
        <span className="ml-auto text-[9px] font-normal bg-muted px-1 rounded">{visible.length}</span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", collapsed && "-rotate-90")}
        />
      </button>

      {!collapsed && (
        <div className="space-y-1">
          {visible.map((s: ProjectSuggestion) => {
            const meta = CATEGORY_META[s.category] ?? CATEGORY_META.feature!;
            const Icon = meta.icon;
            const isSaved = saved.has(s.id) || s.status === "saved";
            return (
              <div
                key={s.id}
                className="group flex items-start gap-2 bg-muted/60 border border-border/60 rounded-lg px-2.5 py-2 hover:border-border transition-colors"
              >
                <Icon className={cn("h-3 w-3 mt-0.5 shrink-0", meta.color)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span className="text-[10px] font-semibold text-foreground">{s.title}</span>
                    <span className={cn("text-[9px] font-medium uppercase tracking-wide shrink-0", meta.color)}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{s.description}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Save / saved toggle */}
                  <button
                    onClick={() => {
                      if (!isSaved) {
                        save.mutate({ id: projectId, suggestionId: s.id });
                      }
                    }}
                    disabled={isSaved}
                    title={isSaved ? "Saved" : "Save for later"}
                    className={cn(
                      "p-1 rounded transition-colors",
                      isSaved
                        ? "text-primary"
                        : "text-muted-foreground/50 hover:text-muted-foreground",
                    )}
                  >
                    {isSaved ? (
                      <BookmarkCheck className="h-3 w-3" />
                    ) : (
                      <Bookmark className="h-3 w-3" />
                    )}
                  </button>

                  {/* Build it */}
                  <button
                    onClick={() => accept.mutate({ id: projectId, suggestionId: s.id })}
                    disabled={accept.isPending}
                    title="Build this"
                    className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 transition-colors"
                  >
                    <Play className="h-2.5 w-2.5" />
                    Build
                  </button>

                  {/* Dismiss */}
                  <button
                    onClick={() => dismiss.mutate({ id: projectId, suggestionId: s.id })}
                    title="Dismiss"
                    className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
