import { useState } from "react";
import type { ProjectSuggestion } from "@workspace/api-client-react";
import {
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  Lightbulb,
  Pencil,
  Play,
  Star,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CATEGORY_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  feature: { label: "Feature", icon: Zap },
  fix: { label: "Fix", icon: Wrench },
  improvement: { label: "Improve", icon: Star },
  idea: { label: "Idea", icon: Lightbulb },
};

type InlineIdeasProps = {
  ideas: ProjectSuggestion[];
  loading?: boolean;
  buildPending?: boolean;
  onBuild: (idea: ProjectSuggestion, promptOverride?: string) => void;
  onSave: (idea: ProjectSuggestion) => void;
  onDismiss: (idea: ProjectSuggestion) => void;
  className?: string;
};

export function InlineIdeas({
  ideas,
  loading = false,
  buildPending = false,
  onBuild,
  onSave,
  onDismiss,
  className,
}: InlineIdeasProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editedPrompt, setEditedPrompt] = useState("");
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const visible = ideas.filter((idea) => !dismissedIds.has(idea.id));

  if (loading) {
    return (
      <div className={cn("flex items-center gap-2 text-[10px] text-muted-foreground", className)}>
        <Lightbulb className="h-3 w-3 animate-pulse" aria-hidden="true" />
        <span>Finding useful next ideas...</span>
      </div>
    );
  }
  if (visible.length === 0) return null;

  return (
    <section className={cn("space-y-1.5", className)} data-testid="inline-ideas">
      <button
        type="button"
        onClick={() => setCollapsed((current) => !current)}
        className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <Lightbulb className="h-3 w-3" aria-hidden="true" />
        <span>New ideas</span>
        <span className="ml-auto rounded bg-muted px-1 text-[9px] font-normal">
          {visible.length}
        </span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", collapsed && "-rotate-90")}
          aria-hidden="true"
        />
      </button>

      {!collapsed && (
        <div className="space-y-1">
          {visible.map((idea) => {
            const meta = CATEGORY_META[idea.category] ?? CATEGORY_META.feature!;
            const Icon = meta.icon;
            const editing = editingId === idea.id;
            const saved = savedIds.has(idea.id) || idea.status === "saved";

            return (
              <article
                key={idea.id}
                className="group flex flex-col gap-1.5 border-l border-border/60 py-1.5 pl-2.5"
                data-testid="inline-idea"
              >
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-1.5">
                      <span className="text-[10px] font-semibold text-foreground">{idea.title}</span>
                      <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                      {idea.description}
                    </p>
                    {!editing && (
                      <p
                        title={idea.prompt}
                        className="mt-0.5 truncate text-[9px] leading-snug text-muted-foreground/50"
                      >
                        {idea.prompt}
                      </p>
                    )}
                  </div>
                  {!editing && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          if (saved) return;
                          setSavedIds((current) => new Set(current).add(idea.id));
                          onSave(idea);
                        }}
                        disabled={saved}
                        title={saved ? "Saved in Ideas" : "Save in Ideas"}
                        className={cn(
                          "rounded p-1 transition-colors",
                          saved
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {saved ? (
                          <BookmarkCheck className="h-3 w-3" />
                        ) : (
                          <Bookmark className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(idea.id);
                          setEditedPrompt(idea.prompt);
                        }}
                        title="Edit before building"
                        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onBuild(idea)}
                        disabled={buildPending}
                        className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
                      >
                        <Play className="h-2.5 w-2.5" />
                        Build
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDismissedIds((current) => new Set(current).add(idea.id));
                          onDismiss(idea);
                        }}
                        title="Dismiss"
                        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>

                {editing && (
                  <div className="ml-5 space-y-1.5">
                    <textarea
                      autoFocus
                      value={editedPrompt}
                      onChange={(event) => setEditedPrompt(event.target.value)}
                      rows={3}
                      className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-[10px] leading-snug text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      placeholder="Edit the build request..."
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          onBuild(idea, editedPrompt);
                          setEditingId(null);
                          setEditedPrompt("");
                        }}
                        disabled={buildPending || !editedPrompt.trim()}
                        className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
                      >
                        <Check className="h-2.5 w-2.5" />
                        Build with edits
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditedPrompt("");
                        }}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
