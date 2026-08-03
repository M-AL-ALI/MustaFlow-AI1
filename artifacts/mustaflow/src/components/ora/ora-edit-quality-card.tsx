import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileCheck2,
  Sparkles,
} from "lucide-react";
import type { OraFileEditQuality } from "@workspace/ora-contracts";
import { cn } from "@/lib/utils";

/**
 * Edit-quality transparency card shown under a generated-file card when the
 * file came out of an edit pipeline (Phase A quality card). Tells the user
 * honestly whether their original file was edited in place, returned
 * unchanged, rebuilt from content, or returned untouched because the edit
 * couldn't be applied safely.
 */

const COLLAPSED_CHANGE_COUNT = 4;

interface ModePresentation {
  label: string;
  sublabel?: string;
  icon: typeof CheckCircle2;
  iconClass: string;
  borderClass: string;
  bgClass: string;
}

function presentationFor(quality: OraFileEditQuality): ModePresentation {
  switch (quality.editMode) {
    case "original_edited":
      return {
        label: "Edited your original file",
        sublabel: quality.preservedLayout === false ? undefined : "Layout and design preserved",
        icon: CheckCircle2,
        iconClass: "text-emerald-500",
        borderClass: "border-emerald-500/25",
        bgClass: "bg-emerald-500/[0.04]",
      };
    case "unchanged":
      return {
        label: "Original file returned unchanged",
        icon: FileCheck2,
        iconClass: "text-muted-foreground",
        borderClass: "border-border/60",
        bgClass: "bg-muted/20",
      };
    case "redesigned":
      return {
        label: "Rebuilt from your content",
        sublabel: "The original layout was not preserved",
        icon: Sparkles,
        iconClass: "text-sky-500",
        borderClass: "border-sky-500/25",
        bgClass: "bg-sky-500/[0.04]",
      };
    case "failed_safe":
      return {
        label: "Edit not applied — original returned unchanged",
        icon: AlertTriangle,
        iconClass: "text-amber-500",
        borderClass: "border-amber-500/30",
        bgClass: "bg-amber-500/[0.05]",
      };
  }
}

export function OraEditQualityCard({
  quality,
  compact = false,
}: {
  quality: OraFileEditQuality;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const mode = presentationFor(quality);
  const Icon = mode.icon;
  const changes = quality.changes ?? [];
  const visibleChanges = expanded ? changes : changes.slice(0, COLLAPSED_CHANGE_COUNT);
  const hiddenCount = changes.length - visibleChanges.length;

  return (
    <div
      className={cn(
        "mt-1.5 w-full rounded-xl border",
        mode.borderClass,
        mode.bgClass,
        compact ? "px-3 py-2" : "px-3.5 py-2.5",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn("shrink-0 mt-0.5", compact ? "h-3.5 w-3.5" : "h-4 w-4", mode.iconClass)}
        />
        <div className="flex-1 min-w-0">
          <p className={cn("font-medium text-foreground", compact ? "text-[11px]" : "text-xs")}>
            {mode.label}
          </p>
          {mode.sublabel && (
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">{mode.sublabel}</p>
          )}
          {quality.warning && (
            <p className="text-[11px] text-amber-500/90 mt-1 leading-snug">{quality.warning}</p>
          )}
          {visibleChanges.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {visibleChanges.map((change, i) => (
                <li
                  key={i}
                  className={cn(
                    "flex items-start gap-1.5 text-muted-foreground leading-snug",
                    compact ? "text-[10px]" : "text-[11px]",
                  )}
                >
                  <span className="shrink-0 mt-[5px] h-1 w-1 rounded-full bg-muted-foreground/50" />
                  <span className="min-w-0 break-words">{change}</span>
                </li>
              ))}
            </ul>
          )}
          {(hiddenCount > 0 || (expanded && changes.length > COLLAPSED_CHANGE_COUNT)) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  Show fewer changes
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {hiddenCount} more {hiddenCount === 1 ? "change" : "changes"}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
