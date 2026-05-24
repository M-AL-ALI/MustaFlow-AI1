import { useState, useEffect } from "react";
import { X, Clock, ChevronDown, ChevronRight, BrainCircuit, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StructuredPlan } from "./plan-card";

type PlanHistoryEntry = {
  id: number;
  content: string;
  plan: StructuredPlan;
  createdAt: string;
  agentMode: string;
};

type DiffSection = {
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
};

function computePlanDiff(before: StructuredPlan, after: StructuredPlan): DiffSection[] {
  const sections: DiffSection[] = [];

  const compareStr = (key: keyof StructuredPlan, label: string) => {
    const a = String(before[key] ?? "");
    const b = String(after[key] ?? "");
    sections.push({ key, label, before: a, after: b, changed: a !== b });
  };

  const compareArray = (key: keyof StructuredPlan, label: string) => {
    const a = (before[key] as string[] | undefined) ?? [];
    const b = (after[key] as string[] | undefined) ?? [];
    const aStr = a.join(", ");
    const bStr = b.join(", ");
    sections.push({ key, label, before: aStr, after: bStr, changed: aStr !== bStr });
  };

  compareStr("goal", "Goal");
  compareStr("approach", "Approach");
  compareStr("recommendedMode", "Recommended Mode");

  const aSitemap = JSON.stringify((before.sitemap ?? []).map((s) => `${s.route} (${s.name})`));
  const bSitemap = JSON.stringify((after.sitemap ?? []).map((s) => `${s.route} (${s.name})`));
  sections.push({
    key: "sitemap",
    label: "Pages",
    before: (before.sitemap ?? []).map((s) => `${s.route} (${s.name})`).join(", "),
    after: (after.sitemap ?? []).map((s) => `${s.route} (${s.name})`).join(", "),
    changed: aSitemap !== bSitemap,
  });

  compareArray("integrations", "Integrations");
  compareArray("backend", "Backend");
  compareArray("database", "Database");
  compareArray("risks", "Risks");

  return sections.filter((s) => s.before !== "" || s.after !== "");
}

function PlanDiffView({
  before,
  after,
}: {
  before: StructuredPlan;
  after: StructuredPlan;
}) {
  const diffs = computePlanDiff(before, after);
  const changed = diffs.filter((d) => d.changed);
  const unchanged = diffs.filter((d) => !d.changed && d.before !== "");

  if (changed.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground/60 italic py-3 text-center">
        No changes between these two plan versions.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {changed.length} field{changed.length !== 1 ? "s" : ""} changed
        {unchanged.length > 0 && (
          <span className="ml-2 font-normal normal-case text-muted-foreground/50">
            · {unchanged.length} unchanged
          </span>
        )}
      </div>
      {changed.map((d) => (
        <div key={d.key} className="rounded-lg border border-border overflow-hidden">
          <div className="px-2 py-1 bg-muted/50 border-b border-border text-[10px] font-semibold text-foreground">
            {d.label}
          </div>
          <div className="grid grid-cols-2 divide-x divide-border">
            <div className="p-2">
              <div className="text-[9px] text-muted-foreground/60 mb-0.5">Before</div>
              <div className="text-[11px] text-red-400/80 line-through leading-relaxed">
                {d.before || <span className="italic text-muted-foreground/40">empty</span>}
              </div>
            </div>
            <div className="p-2">
              <div className="text-[9px] text-muted-foreground/60 mb-0.5">After</div>
              <div className="text-[11px] text-green-400/80 leading-relaxed">
                {d.after || <span className="italic text-muted-foreground/40">removed</span>}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanHistoryEntry({
  entry,
  prevEntry,
  onRestore,
}: {
  entry: PlanHistoryEntry;
  prevEntry?: PlanHistoryEntry;
  onRestore: (plan: StructuredPlan) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const date = new Date(entry.createdAt);
  const formatted = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
        }}
      >
        <BrainCircuit className="h-3.5 w-3.5 text-secondary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground truncate">
              {typeof entry.plan.goal === "string"
                ? entry.plan.goal.slice(0, 70)
                : entry.content.slice(0, 70)}
            </span>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground">{formatted}</span>
            {entry.plan.complexityScore && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                complexity {entry.plan.complexityScore}
              </span>
            )}
            {entry.agentMode && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-muted border border-border text-muted-foreground capitalize">
                {entry.agentMode} mode
              </span>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-3 bg-muted/10">
          {/* Summary */}
          {entry.plan.summary && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">{entry.plan.summary}</p>
          )}

          {/* Pages preview */}
          {entry.plan.sitemap && entry.plan.sitemap.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.plan.sitemap.map((page, i) => (
                <span
                  key={i}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground"
                >
                  {page.name}
                </span>
              ))}
            </div>
          )}

          {/* Diff with previous version */}
          {prevEntry && (
            <div>
              <button
                onClick={() => setShowDiff((v) => !v)}
                className="text-[10px] text-primary/80 hover:text-primary flex items-center gap-1 transition-colors"
              >
                {showDiff ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {showDiff ? "Hide" : "Show"} diff from previous version
              </button>
              {showDiff && (
                <div className="mt-2">
                  <PlanDiffView before={prevEntry.plan} after={entry.plan} />
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => onRestore(entry.plan)}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/15 transition-colors border border-primary/20"
          >
            <ArrowLeft className="h-3 w-3" />
            Restore this plan
          </button>
        </div>
      )}
    </div>
  );
}

interface PlanHistoryPanelProps {
  projectId: number;
  onRestorePlan: (plan: StructuredPlan) => void;
  onClose: () => void;
}

export function PlanHistoryPanel({ projectId, onRestorePlan, onClose }: PlanHistoryPanelProps) {
  const [entries, setEntries] = useState<PlanHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/projects/${projectId}/plan-history`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load plan history");
        const data = (await r.json()) as PlanHistoryEntry[];
        setEntries(data);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
      <div
        className="bg-background border border-border rounded-2xl w-full max-w-lg max-h-[75vh] flex flex-col shadow-2xl"
        role="dialog"
        aria-label="Plan History"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-semibold text-sm flex-1">Plan History</span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Loading plan history…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-32 text-sm text-destructive">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground text-center">
              No plan history yet. Use Plan Mode to generate a plan and it will appear here.
            </div>
          ) : (
            entries.map((entry, i) => (
              <PlanHistoryEntry
                key={entry.id}
                entry={entry}
                prevEntry={entries[i + 1]}
                onRestore={(plan) => {
                  onRestorePlan(plan);
                  onClose();
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function PlanDiffBadge({
  currentPlan,
  previousPlan,
}: {
  currentPlan: StructuredPlan;
  previousPlan: StructuredPlan;
}) {
  const [open, setOpen] = useState(false);
  const diffs = computePlanDiff(previousPlan, currentPlan);
  const changedCount = diffs.filter((d) => d.changed).length;

  if (changedCount === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/15 transition-colors"
        title="See what changed from the previous plan version"
      >
        {changedCount} change{changedCount !== 1 ? "s" : ""} from previous
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="bg-background border border-border rounded-2xl w-full max-w-lg max-h-[70vh] flex flex-col shadow-2xl">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
              <span className="font-semibold text-sm flex-1">Plan diff</span>
              <button
                onClick={() => setOpen(false)}
                className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <PlanDiffView before={previousPlan} after={currentPlan} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { PlanDiffView };
export type { PlanHistoryEntry };
