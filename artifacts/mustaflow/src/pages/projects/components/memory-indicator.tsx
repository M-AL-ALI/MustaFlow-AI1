import { useState } from "react";
import {
  useListKnowledge,
  deleteKnowledge,
  getListKnowledgeQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Trash2, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function MemoryIndicator({ projectId }: { projectId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const queryClient = useQueryClient();

  const summaryParams = { projectId, type: "conversation_summary" };
  const { data: entries = [], isLoading } = useListKnowledge(summaryParams, {
    query: {
      queryKey: getListKnowledgeQueryKey(summaryParams),
      staleTime: 30000,
      refetchInterval: false,
    },
  });

  const summaryEntry = entries[0];

  if (isLoading || !summaryEntry) return null;

  const handleClear = async () => {
    if (entries.length === 0) return;
    setClearing(true);
    try {
      await Promise.all(entries.map((e) => deleteKnowledge(e.id)));
      void queryClient.invalidateQueries({
        queryKey: getListKnowledgeQueryKey(summaryParams),
      });
      setExpanded(false);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="shrink-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium transition-colors border-b border-border/40",
          expanded
            ? "bg-blue-500/10 text-blue-400 border-b-blue-500/20"
            : "bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60",
        )}
        title="The AI has remembered context from your past conversations in this project"
      >
        <BrainCircuit className="h-3 w-3 shrink-0 text-blue-400" />
        <span className="flex-1 text-left">Memory active — AI remembers past conversations</span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-b border-border/40 bg-blue-500/5">
          <div className="px-3 pt-2 pb-1 flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wide">
              What the AI remembers
            </span>
            <button
              onClick={() => void handleClear()}
              disabled={clearing}
              className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50 px-1.5 py-0.5 rounded hover:bg-red-500/10"
              title="Clear this memory — the AI will start fresh on the next message"
            >
              {clearing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Clear memory
            </button>
          </div>
          <div className="px-3 pb-2.5">
            <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {summaryEntry.content}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
