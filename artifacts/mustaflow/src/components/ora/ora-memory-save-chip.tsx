import { useState } from "react";
import { ArrowUpRight, Brain, Check, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline "Save to memory" affordance shown beneath an assistant message that
 * carries a memory candidate (a durable fact Ora detected). Once saved it
 * collapses to a small confirmation that links straight to the Memory Center so
 * the user can see exactly where the memory now lives. The actual persistence +
 * transcript update is owned by the parent via `onSave`; this component only
 * manages its own in-flight / error UI.
 */
export function OraMemorySaveChip({
  fact,
  saved,
  sensitive = false,
  supersededTitles,
  onSave,
  onOpenMemoryCenter,
}: {
  fact: string;
  saved: boolean;
  /** When true, the fact looks like PII/credentials — warn and never auto-save. */
  sensitive?: boolean;
  /**
   * Titles of earlier memories this save replaced (a contradicting update like
   * "dark mode" → "light mode"). When present, the saved confirmation names what
   * changed so the behavior is transparent.
   */
  supersededTitles?: string[];
  onSave: () => Promise<void>;
  /** Opens the Memory Center so the user can see the saved entry. */
  onOpenMemoryCenter?: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  if (saved) {
    const replaced = supersededTitles?.filter((t) => t.trim().length > 0) ?? [];
    if (replaced.length > 0) {
      const replacedLabel =
        replaced.length === 1 ? `“${replaced[0]}”` : `${replaced.length} earlier memories`;
      return (
        <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.05)] px-3 py-2 text-[11px] text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 text-[hsl(265_85%_65%)] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="text-foreground/85">
              Updated your memory — I&apos;ll remember this instead of {replacedLabel}.
            </span>{" "}
            {onOpenMemoryCenter && (
              <button
                type="button"
                onClick={onOpenMemoryCenter}
                className="inline-flex items-center gap-0.5 font-medium text-[hsl(265_85%_65%)] hover:underline align-baseline"
              >
                Review or undo
                <ArrowUpRight className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-emerald-500" />
        <span>Saved to memory</span>
        {onOpenMemoryCenter && (
          <button
            type="button"
            onClick={onOpenMemoryCenter}
            className="inline-flex items-center gap-0.5 font-medium text-[hsl(265_85%_65%)] hover:underline"
          >
            View in Memory Center
            <ArrowUpRight className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-start gap-2 rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.05)] px-3 py-2">
      <Brain className="h-4 w-4 text-[hsl(265_85%_65%)] shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-muted-foreground">Save this to memory?</p>
        <p className="text-xs text-foreground/85 break-words mt-0.5">{fact}</p>
        {sensitive && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            This looks like sensitive info. It won&apos;t be saved unless you confirm.
          </p>
        )}
        {status === "error" && (
          <p className="text-[11px] text-destructive mt-1">Couldn&apos;t save. Try again.</p>
        )}
      </div>
      <button
        type="button"
        disabled={status === "saving"}
        onClick={async () => {
          setStatus("saving");
          try {
            await onSave();
          } catch {
            setStatus("error");
          }
        }}
        className={cn(
          "shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors",
          "bg-[hsl(265_85%_65%/0.15)] text-[hsl(265_85%_65%)] hover:bg-[hsl(265_85%_65%/0.25)]",
          status === "saving" && "opacity-60",
        )}
      >
        {status === "saving" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Brain className="h-3.5 w-3.5" />
        )}
        Save
      </button>
    </div>
  );
}
