import {
  useListSuggestions,
  useAcceptSuggestion,
  useDismissSuggestion,
  getListSuggestionsQueryKey,
  type ProjectSuggestion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  Bookmark,
  Lightbulb,
  Wrench,
  Star,
  Zap,
  Play,
  X,
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

interface SavedSuggestionsTabProps {
  projectId: number;
  onAccepted?: (taskId: number) => void;
}

export function SavedSuggestionsTab({ projectId, onAccepted }: SavedSuggestionsTabProps) {
  const queryClient = useQueryClient();

  const { data: suggestions, isLoading } = useListSuggestions(
    projectId,
    {},
    {
      query: {
        queryKey: getListSuggestionsQueryKey(projectId, {}),
        refetchInterval: false,
        staleTime: 30000,
      },
    },
  );

  const saved = (suggestions ?? []).filter(
    (s: ProjectSuggestion) => s.status === "saved",
  );

  const accept = useAcceptSuggestion({
    mutation: {
      onSuccess: (data) => {
        void queryClient.invalidateQueries({
          queryKey: getListSuggestionsQueryKey(projectId, {}),
        });
        if (data.taskId && onAccepted) {
          onAccepted(data.taskId);
        }
      },
    },
  });

  const dismiss = useDismissSuggestion({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListSuggestionsQueryKey(projectId, {}),
        });
      },
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading…
      </div>
    );
  }

  if (saved.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground px-4">
        <Bookmark className="h-8 w-8 opacity-25" />
        <div className="text-center">
          <div className="text-xs font-medium text-foreground/60">No saved suggestions</div>
          <div className="text-[10px] opacity-50 mt-0.5">
            Save ideas from build reports to review later
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-2 space-y-1 px-2">
      {saved.map((s: ProjectSuggestion) => {
        const meta = CATEGORY_META[s.category] ?? CATEGORY_META.feature!;
        const Icon = meta.icon;
        return (
          <div
            key={s.id}
            className="group flex items-start gap-2 bg-muted/50 border border-border/60 rounded-lg px-2.5 py-2 hover:border-border transition-colors"
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
              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  onClick={() => accept.mutate({ id: projectId, suggestionId: s.id })}
                  disabled={accept.isPending}
                  className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 transition-colors"
                >
                  <Play className="h-2.5 w-2.5" />
                  Build now
                </button>
                <button
                  onClick={() => dismiss.mutate({ id: projectId, suggestionId: s.id })}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  <X className="h-2.5 w-2.5" />
                  Remove
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
