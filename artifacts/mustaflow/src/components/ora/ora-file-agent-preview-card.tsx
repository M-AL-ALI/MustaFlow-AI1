import {
  BarChart3,
  CheckCircle2,
  ClipboardList,
  FileCog,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import type { OraFileAgentPreview } from "@workspace/ora-contracts";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<OraFileAgentPreview["status"], string> = {
  applied: "Applied",
  planned: "Planned",
  unchanged: "Unchanged",
  failed_safe: "Safe fallback",
  needs_confirmation: "Needs confirmation",
};

function statusClass(status: OraFileAgentPreview["status"]): string {
  if (status === "applied") return "border-emerald-500/25 bg-emerald-500/[0.04]";
  if (status === "failed_safe") return "border-amber-500/30 bg-amber-500/[0.05]";
  if (status === "unchanged") return "border-border/60 bg-muted/20";
  return "border-sky-500/25 bg-sky-500/[0.04]";
}

function Section({
  icon: Icon,
  title,
  items,
  compact,
}: {
  icon: typeof ClipboardList;
  title: string;
  items?: string[];
  compact?: boolean;
}) {
  const visible = (items ?? []).filter(Boolean).slice(0, compact ? 3 : 5);
  if (visible.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        <Icon className="h-3 w-3" />
        <span>{title}</span>
      </div>
      <ul className="space-y-1">
        {visible.map((item, i) => (
          <li
            key={`${title}-${i}`}
            className={cn(
              "flex items-start gap-1.5 leading-snug text-muted-foreground",
              compact ? "text-[10px]" : "text-[11px]",
            )}
          >
            <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OraFileAgentPreviewCard({
  preview,
  compact = false,
}: {
  preview?: OraFileAgentPreview;
  compact?: boolean;
}) {
  if (!preview) return null;
  const visibleSections = [
    preview.detectedInputs?.length,
    preview.plannedActions?.length,
    preview.calculations?.length,
    preview.charts?.length,
    preview.outputSections?.length,
    preview.assumptions?.length,
    preview.safetyNotes?.length,
  ].filter(Boolean).length;

  return (
    <div
      className={cn(
        "mt-1.5 w-full rounded-xl border",
        statusClass(preview.status),
        compact ? "px-3 py-2" : "px-3.5 py-2.5",
      )}
    >
      <div className="flex items-start gap-2">
        <FileCog
          className={cn("mt-0.5 shrink-0 text-primary", compact ? "h-3.5 w-3.5" : "h-4 w-4")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className={cn("font-medium text-foreground", compact ? "text-[11px]" : "text-xs")}>
              {preview.title}
            </p>
            <span className="rounded-full border border-border/60 bg-background/55 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {STATUS_LABEL[preview.status]}
            </span>
          </div>
          {preview.summary ? (
            <p
              className={cn(
                "mt-1 leading-snug text-muted-foreground",
                compact ? "text-[10px]" : "text-[11px]",
              )}
            >
              {preview.summary}
            </p>
          ) : null}

          {visibleSections > 0 ? (
            <div className={cn("mt-2 grid gap-2", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
              <Section
                icon={ClipboardList}
                title="Detected"
                items={preview.detectedInputs}
                compact={compact}
              />
              <Section
                icon={ListChecks}
                title="Plan"
                items={preview.plannedActions}
                compact={compact}
              />
              <Section
                icon={CheckCircle2}
                title="Calculations"
                items={preview.calculations}
                compact={compact}
              />
              <Section icon={BarChart3} title="Charts" items={preview.charts} compact={compact} />
              <Section
                icon={ClipboardList}
                title="Sections"
                items={preview.outputSections}
                compact={compact}
              />
              <Section
                icon={ShieldCheck}
                title="Checks"
                items={[...(preview.assumptions ?? []), ...(preview.safetyNotes ?? [])]}
                compact={compact}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
