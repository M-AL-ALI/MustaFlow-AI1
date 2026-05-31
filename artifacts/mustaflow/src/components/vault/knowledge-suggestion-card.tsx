import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";

export interface KnowledgeSuggestion {
  entryId: number;
  title: string;
  category: string;
  department: string | null;
  summary: string;
  tags: string[];
  status: string;
  version: number;
  chunkPreview: string;
  similarityScore: number;
  updatedAt: string;
}

interface KnowledgeSuggestionCardProps {
  suggestion: KnowledgeSuggestion;
  selected: boolean;
  onToggle: () => void;
}

export function KnowledgeSuggestionCard({
  suggestion,
  selected,
  onToggle,
}: KnowledgeSuggestionCardProps) {
  const score = Math.round(suggestion.similarityScore);
  const scoreColor =
    score >= 70 ? "text-green-400" : score >= 50 ? "text-yellow-400" : "text-muted-foreground";

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "w-full text-left border rounded-lg p-3 transition-colors space-y-1.5",
        selected
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card hover:border-primary/30",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 justify-between">
            <h4 className="text-sm font-medium text-foreground leading-snug line-clamp-2 flex-1">
              {suggestion.title}
            </h4>
            <span
              className={cn("text-[10px] font-medium tabular-nums shrink-0 mt-0.5", scoreColor)}
            >
              {score}%
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/60 bg-muted/40 text-muted-foreground font-medium">
              {suggestion.category}
            </span>
            {suggestion.department && (
              <span className="text-[10px] text-muted-foreground/70">{suggestion.department}</span>
            )}
            <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
              v{suggestion.version}
            </span>
          </div>
          {suggestion.chunkPreview && (
            <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
              {suggestion.chunkPreview}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
