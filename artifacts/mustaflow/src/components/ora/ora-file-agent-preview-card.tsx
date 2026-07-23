import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  FileCog,
  ListChecks,
  ShieldCheck,
  X,
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
  onApply,
  onRevise,
  onRedesign,
  onCancel,
  disabled = false,
}: {
  preview?: OraFileAgentPreview;
  compact?: boolean;
  onApply?: () => void;
  onRevise?: () => void;
  onRedesign?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
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

          {preview.status === "needs_confirmation" &&
          (onApply || onRevise || onRedesign || onCancel) ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {onApply ? (
                <button
                  type="button"
                  onClick={onApply}
                  disabled={disabled}
                  className={cn(
                    "rounded-md bg-primary px-2.5 py-1 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50",
                    compact ? "text-[10px]" : "text-[11px]",
                  )}
                >
                  Apply edit
                </button>
              ) : null}
              {onRevise ? (
                <button
                  type="button"
                  onClick={onRevise}
                  disabled={disabled}
                  className={cn(
                    "rounded-md border border-border/70 bg-background/60 px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50",
                    compact ? "text-[10px]" : "text-[11px]",
                  )}
                >
                  Revise plan
                </button>
              ) : null}
              {onRedesign ? (
                <button
                  type="button"
                  onClick={onRedesign}
                  disabled={disabled}
                  className={cn(
                    "rounded-md border border-border/70 bg-background/60 px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50",
                    compact ? "text-[10px]" : "text-[11px]",
                  )}
                >
                  Create redesigned copy
                </button>
              ) : null}
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={disabled}
                  className={cn(
                    "flex items-center gap-1 rounded-md border border-border/50 bg-transparent px-2 py-1 font-medium text-muted-foreground/70 transition-colors hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50",
                    compact ? "text-[10px]" : "text-[11px]",
                  )}
                >
                  <X className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
                  Never mind
                </button>
              ) : null}
            </div>
          ) : null}

          {preview.contentChanges && preview.contentChanges.length > 0 ? (
            <div className="mt-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                <ArrowRight className="h-3 w-3" />
                <span>Content being changed</span>
              </div>
              {preview.contentChanges.map((change, i) => (
                <div
                  key={`cc-${i}`}
                  className="flex flex-wrap items-center gap-1.5 leading-snug"
                >
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {change.label}
                  </span>
                  {change.from ? (
                    <>
                      <code className="rounded bg-destructive/10 px-1 py-px text-[10px] text-destructive/80 line-through">
                        {change.from}
                      </code>
                      <ArrowRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />
                      <code className="rounded bg-primary/10 px-1 py-px text-[10px] text-primary/80">
                        {change.to ?? "…"}
                      </code>
                    </>
                  ) : change.to ? (
                    <code className="rounded bg-primary/10 px-1 py-px text-[10px] text-primary/80">
                      {change.to}
                    </code>
                  ) : null}
                </div>
              ))}
            </div>
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
