import { useState } from "react";
import {
  useListSuggestions,
  useAcceptSuggestion,
  useDismissSuggestion,
  useSaveSuggestion,
  getListSuggestionsQueryKey,
  type ProjectSuggestion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  Bookmark,
  BookmarkCheck,
  Lightbulb,
  Wrench,
  Star,
  Zap,
  Play,
  X,
  Pencil,
  Check,
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editedPrompt, setEditedPrompt] = useState("");

  const { data: suggestions, isLoading } = useListSuggestions(
    projectId,
    {},
    {
      query: {
        queryKey: getListSuggestionsQueryKey(projectId, {}),
        // Poll every 30s so background build suggestions surface automatically
        refetchInterval: 30000,
        staleTime: 10000,
      },
    },
  );

  const saved = (suggestions ?? []).filter((s: ProjectSuggestion) => s.status === "saved");

  // Pending suggestions include output from background builds that never had a
  // foreground SuggestionChips panel attached to them.
  const pending = (suggestions ?? []).filter((s: ProjectSuggestion) => s.status === "pending");

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

  const save = useSaveSuggestion({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListSuggestionsQueryKey(projectId, {}),
        });
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

  const handleStartEdit = (s: ProjectSuggestion) => {
    setEditingId(s.id);
    setEditedPrompt(s.prompt);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditedPrompt("");
  };

  const handleBuild = (s: ProjectSuggestion, promptOverride?: string) => {
    const override = promptOverride?.trim();
    accept.mutate({
      id: projectId,
      suggestionId: s.id,
      ...(override && override !== s.prompt ? { data: { promptOverride: override } } : {}),
    });
    setEditingId(null);
    setEditedPrompt("");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading…
      </div>
    );
  }

  if (pending.length === 0 && saved.length === 0) {
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
    <div className="flex-1 overflow-y-auto py-2 space-y-3 px-2">
      {/* Pending suggestions — surfaced from background builds */}
      {pending.length > 0 && (
        <div className="space-y-1">
          <div className="px-0.5 pb-0.5 flex items-center gap-1.5">
            <Lightbulb className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
              New ideas
            </span>
            <span className="ml-1 px-1 py-0.5 rounded-full bg-primary/15 text-primary text-[9px] font-semibold leading-none">
              {pending.length}
            </span>
          </div>

          {pending.map((s: ProjectSuggestion) => {
            const meta = CATEGORY_META[s.category] ?? CATEGORY_META.feature!;
            const Icon = meta.icon;
            const isEditing = editingId === s.id;
            return (
              <div
                key={s.id}
                className="group flex flex-col gap-1.5 bg-muted/50 border border-border/60 rounded-lg px-2.5 py-2 hover:border-border transition-colors"
              >
                <div className="flex items-start gap-2">
                  <Icon className={cn("h-3 w-3 mt-0.5 shrink-0", meta.color)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="text-[10px] font-semibold text-foreground">{s.title}</span>
                      <span
                        className={cn(
                          "text-[9px] font-medium uppercase tracking-wide shrink-0",
                          meta.color,
                        )}
                      >
                        {meta.label}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">
                      {s.description}
                    </p>
                    {!isEditing && (
                      <p
                        title={s.prompt}
                        className="text-[9px] text-muted-foreground/40 leading-snug mt-0.5 truncate cursor-default"
                      >
                        {s.prompt}
                      </p>
                    )}
                  </div>
                </div>

                {/* Inline prompt editor */}
                {isEditing && (
                  <div className="flex flex-col gap-1.5 pl-5">
                    <textarea
                      autoFocus
                      value={editedPrompt}
                      onChange={(e) => setEditedPrompt(e.target.value)}
                      rows={3}
                      className="w-full text-[10px] bg-background border border-border rounded px-2 py-1.5 text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 leading-snug"
                      placeholder="Edit the prompt…"
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleBuild(s, editedPrompt)}
                        disabled={accept.isPending || !editedPrompt.trim()}
                        className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 disabled:opacity-50 transition-colors"
                      >
                        <Check className="h-2.5 w-2.5" />
                        Build with edits
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {!isEditing && (
                  <div className="flex items-center gap-1.5 pl-5">
                    <button
                      onClick={() => handleBuild(s)}
                      disabled={accept.isPending}
                      className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 transition-colors"
                    >
                      <Play className="h-2.5 w-2.5" />
                      Build now
                    </button>
                    <button
                      onClick={() => handleStartEdit(s)}
                      title="Edit prompt before building"
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      Edit &amp; Build
                    </button>
                    <button
                      onClick={() => save.mutate({ id: projectId, suggestionId: s.id })}
                      disabled={save.isPending}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
                    >
                      <BookmarkCheck className="h-2.5 w-2.5" />
                      Save
                    </button>
                    <button
                      onClick={() => dismiss.mutate({ id: projectId, suggestionId: s.id })}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Saved suggestions */}
      {saved.length > 0 && (
        <div className="space-y-1">
          {pending.length > 0 && (
            <div className="px-0.5 pb-0.5 flex items-center gap-1.5">
              <Bookmark className="h-3 w-3 text-muted-foreground/60" />
              <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                Saved
              </span>
            </div>
          )}
          {saved.map((s: ProjectSuggestion) => {
            const meta = CATEGORY_META[s.category] ?? CATEGORY_META.feature!;
            const Icon = meta.icon;
            const isEditing = editingId === s.id;
            return (
              <div
                key={s.id}
                className="group flex flex-col gap-1.5 bg-muted/50 border border-border/60 rounded-lg px-2.5 py-2 hover:border-border transition-colors"
              >
                <div className="flex items-start gap-2">
                  <Icon className={cn("h-3 w-3 mt-0.5 shrink-0", meta.color)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="text-[10px] font-semibold text-foreground">{s.title}</span>
                      <span
                        className={cn(
                          "text-[9px] font-medium uppercase tracking-wide shrink-0",
                          meta.color,
                        )}
                      >
                        {meta.label}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">
                      {s.description}
                    </p>
                    {!isEditing && (
                      <p
                        title={s.prompt}
                        className="text-[9px] text-muted-foreground/40 leading-snug mt-0.5 truncate cursor-default"
                      >
                        {s.prompt}
                      </p>
                    )}
                  </div>
                </div>

                {/* Inline prompt editor */}
                {isEditing && (
                  <div className="flex flex-col gap-1.5 pl-5">
                    <textarea
                      autoFocus
                      value={editedPrompt}
                      onChange={(e) => setEditedPrompt(e.target.value)}
                      rows={3}
                      className="w-full text-[10px] bg-background border border-border rounded px-2 py-1.5 text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 leading-snug"
                      placeholder="Edit the prompt…"
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleBuild(s, editedPrompt)}
                        disabled={accept.isPending || !editedPrompt.trim()}
                        className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 disabled:opacity-50 transition-colors"
                      >
                        <Check className="h-2.5 w-2.5" />
                        Build with edits
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {!isEditing && (
                  <div className="flex items-center gap-1.5 pl-5">
                    <button
                      onClick={() => handleBuild(s)}
                      disabled={accept.isPending}
                      className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-primary hover:bg-primary/15 transition-colors"
                    >
                      <Play className="h-2.5 w-2.5" />
                      Build now
                    </button>
                    <button
                      onClick={() => handleStartEdit(s)}
                      title="Edit prompt before building"
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      Edit &amp; Build
                    </button>
                    <button
                      onClick={() => dismiss.mutate({ id: projectId, suggestionId: s.id })}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                      Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
