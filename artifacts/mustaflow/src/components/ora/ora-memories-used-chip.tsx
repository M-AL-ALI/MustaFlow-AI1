import { useState } from "react";
import { Brain, ChevronDown, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OraMemoryUsed } from "@/hooks/use-ora-chat";

/**
 * Unobtrusive "based on your saved memories" indicator shown beneath an
 * assistant reply that was shaped by one or more saved Ora memories. Collapsed
 * by default; expanding it lists the memory titles that were applied and offers
 * a deep link into the Memory Center to manage them.
 *
 * Strictly Ora-scoped: the parent only ever passes memories with scope="user"
 * and origin="ora", so no AI Builder / project knowledge can surface here.
 */
export function OraMemoriesUsedChip({
  memories,
  onOpenMemoryCenter,
}: {
  memories: OraMemoryUsed[];
  /** Opens the Memory Center so the user can review/manage these memories. */
  onOpenMemoryCenter?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (memories.length === 0) return null;

  const label =
    memories.length === 1
      ? "Based on 1 saved memory"
      : `Based on ${memories.length} saved memories`;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3.5 w-3.5 text-[hsl(265_85%_65%)]" />
        <span>{label}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-1.5 rounded-xl border border-[hsl(265_85%_65%/0.25)] bg-[hsl(265_85%_65%/0.04)] px-3 py-2">
          <ul className="space-y-1">
            {memories.map((m) => (
              <li key={m.id} className="flex items-start gap-1.5 text-[11px] text-foreground/80">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[hsl(265_85%_65%)]" />
                <span className="break-words">{m.title}</span>
              </li>
            ))}
          </ul>
          {onOpenMemoryCenter && (
            <button
              type="button"
              onClick={onOpenMemoryCenter}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[hsl(265_85%_65%)] hover:underline"
            >
              <Settings2 className="h-3 w-3" />
              Manage in Memory Center
            </button>
          )}
        </div>
      )}
    </div>
  );
}
