import { useState } from "react";
import { Check, X, ChevronDown, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LiveFileDiff {
  path: string;
  op: "write" | "patch" | "delete";
}

export interface LiveCheckResult {
  id: string;
  label: string;
  passed: boolean;
  message: string;
}

interface LiveAgentProgressProps {
  narrations: string[];
  thought: string | null;
  fileDiffs: LiveFileDiff[];
  checkResults: LiveCheckResult[];
}

export function LiveAgentProgress({
  narrations,
  thought,
  fileDiffs,
  checkResults,
}: LiveAgentProgressProps) {
  const [filesExpanded, setFilesExpanded] = useState(false);

  if (
    narrations.length === 0 &&
    thought === null &&
    fileDiffs.length === 0 &&
    checkResults.length === 0
  ) {
    return null;
  }

  const recentNarrations = narrations.slice(-6);

  return (
    <div className="flex flex-col gap-2 bg-muted/30 border border-border/50 rounded-xl px-3 py-2.5 text-left">
      {recentNarrations.length > 0 && (
        <div className="flex flex-col gap-1">
          {recentNarrations.map((text, i) => {
            const isCurrent = i === recentNarrations.length - 1;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-center gap-2 text-[11px] leading-snug",
                  isCurrent ? "text-foreground" : "text-muted-foreground/40",
                )}
              >
                {isCurrent ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                ) : (
                  <Check className="w-3 h-3 text-muted-foreground/25 shrink-0" />
                )}
                <span>{text}</span>
              </div>
            );
          })}
        </div>
      )}

      {thought && (
        <p className="text-[10px] text-muted-foreground/55 italic pl-3.5 border-l border-border/40 leading-relaxed line-clamp-3">
          {thought}
        </p>
      )}

      {checkResults.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {checkResults.map((c) => (
            <span
              key={c.id}
              title={c.message}
              className={cn(
                "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                c.passed
                  ? "bg-green-500/10 text-green-400 border border-green-500/20"
                  : "bg-red-500/10 text-red-400 border border-red-500/20",
              )}
            >
              {c.passed ? (
                <Check className="w-2.5 h-2.5 shrink-0" />
              ) : (
                <X className="w-2.5 h-2.5 shrink-0" />
              )}
              {c.label}
            </span>
          ))}
        </div>
      )}

      {fileDiffs.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setFilesExpanded((e) => !e)}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground/55 hover:text-muted-foreground transition-colors w-fit"
          >
            <FileCode className="w-3 h-3 shrink-0" />
            <span>
              {fileDiffs.length} file{fileDiffs.length !== 1 ? "s" : ""} changed
            </span>
            <ChevronDown
              className={cn(
                "w-3 h-3 transition-transform",
                filesExpanded && "rotate-180",
              )}
            />
          </button>
          {filesExpanded && (
            <div className="pl-4 flex flex-col gap-0.5 border-l border-border/30 ml-1.5">
              {fileDiffs.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0",
                      f.op === "delete"
                        ? "bg-red-400/70"
                        : f.op === "patch"
                          ? "bg-amber-400/70"
                          : "bg-green-400/70",
                    )}
                  />
                  <span className="font-mono text-muted-foreground/65 truncate max-w-[240px]">
                    {f.path}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
