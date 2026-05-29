import { cn } from "@/lib/utils";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";

interface DatasetResultCardProps {
  result: DatasetAnalysisResult;
}

const PRIORITY_COLOR = {
  high: "text-red-400",
  medium: "text-amber-400",
  low: "text-muted-foreground",
};

const DIRECTION_SYMBOL = {
  up: "↑",
  down: "↓",
  flat: "→",
  unknown: "—",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </p>
      {children}
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs text-foreground/85">
          <span className="mt-1 shrink-0 text-[hsl(265_85%_65%)]">•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-xs text-foreground/85">
          <span className="shrink-0 min-w-[16px] font-semibold text-[hsl(265_85%_65%)]">{i + 1}.</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function DatasetResultCard({ result }: DatasetResultCardProps) {
  const dp = result.datasetProfile;

  return (
    <div className="rounded-xl border border-[hsl(265_85%_65%/0.25)] bg-[hsl(265_85%_65%/0.04)] p-3.5 text-sm max-w-full overflow-x-hidden">
      {/* Header */}
      <div className="flex items-start gap-2 mb-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-400/15 border border-amber-400/30 mt-0.5">
          <span className="text-[10px] font-bold text-amber-400">D</span>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground leading-tight">Dataset Analysis</p>
          {dp && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {dp.rowCount.toLocaleString()} rows × {dp.colCount} columns
              {dp.sheetName ? ` · Sheet: ${dp.sheetName}` : ""}
              {dp.truncated ? " · (capped at 10K rows)" : ""}
            </p>
          )}
          {result.sanitizedCellCount > 0 && (
            <p className="text-[10px] text-amber-400/70 mt-0.5">
              {result.sanitizedCellCount} formula character(s) neutralized
            </p>
          )}
        </div>
      </div>

      {/* Summary */}
      <p className="text-xs text-foreground/90 leading-relaxed">{result.summary}</p>

      {/* Key Findings */}
      {result.keyFindings && result.keyFindings.length > 0 && (
        <Section title="Key Findings">
          <BulletList items={result.keyFindings} />
        </Section>
      )}

      {/* KPI Gaps */}
      {result.kpiGaps && result.kpiGaps.length > 0 && (
        <Section title="KPI Gaps">
          <div className="space-y-1.5">
            {result.kpiGaps.map((kpi, i) => (
              <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
                <p className="text-xs font-medium text-foreground">{kpi.metric}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">Current: <span className="text-foreground/80">{kpi.current}</span></span>
                  {kpi.target && <span className="text-[10px] text-muted-foreground">Target: <span className="text-foreground/80">{kpi.target}</span></span>}
                  {kpi.gap && <span className="text-[10px] text-muted-foreground">Gap: <span className="text-foreground/80">{kpi.gap}</span></span>}
                  {kpi.trend && <span className="text-[10px] text-muted-foreground">Trend: <span className="text-foreground/80">{kpi.trend}</span></span>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Trend Findings */}
      {result.trendFindings && result.trendFindings.length > 0 && (
        <Section title="Trend Analysis">
          <ul className="space-y-1">
            {result.trendFindings.map((t, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-foreground/85">
                {t.direction && (
                  <span className={cn("shrink-0 font-bold", t.direction === "up" ? "text-green-400" : t.direction === "down" ? "text-red-400" : "text-muted-foreground")}>
                    {DIRECTION_SYMBOL[t.direction]}
                  </span>
                )}
                <span>{t.description}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Pareto Findings */}
      {result.paretoFindings && result.paretoFindings.length > 0 && (
        <Section title="Pareto Analysis (80/20)">
          <div className="space-y-1">
            {result.paretoFindings.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 w-4 text-[10px] text-muted-foreground text-right">{i + 1}.</span>
                <span className="flex-1 truncate text-foreground/85">{p.label}</span>
                <span className="shrink-0 font-medium text-foreground/80">{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</span>
                {p.cumPct !== undefined && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">({p.cumPct}%)</span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Root Cause Analysis */}
      {result.rootCauseAnalysis && (
        <Section title="Root Cause Analysis">
          {result.rootCauseAnalysis.fiveWhys.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] font-medium text-muted-foreground mb-1">5 Whys</p>
              <ol className="space-y-0.5">
                {result.rootCauseAnalysis.fiveWhys.map((why, i) => (
                  <li key={i} className="text-xs text-foreground/85 pl-2">{why}</li>
                ))}
              </ol>
            </div>
          )}
          {Object.keys(result.rootCauseAnalysis.fishbone).length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] font-medium text-muted-foreground mb-1">Fishbone Categories</p>
              <div className="space-y-1">
                {Object.entries(result.rootCauseAnalysis.fishbone).map(([category, causes]) => (
                  <div key={category}>
                    <span className="text-[10px] font-semibold text-[hsl(265_85%_65%)]">{category}: </span>
                    <span className="text-xs text-foreground/80">{causes.join("; ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.rootCauseAnalysis.likelyCauses.length > 0 && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-1">Most Likely Causes</p>
              <BulletList items={result.rootCauseAnalysis.likelyCauses} />
            </div>
          )}
        </Section>
      )}

      {/* Recommendations */}
      {result.recommendations && result.recommendations.length > 0 && (
        <Section title="Recommendations">
          <NumberedList items={result.recommendations} />
        </Section>
      )}

      {/* Action Plan */}
      {result.actionPlan && result.actionPlan.length > 0 && (
        <Section title="Action Plan">
          <div className="space-y-1.5">
            {result.actionPlan.map((item, i) => (
              <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-foreground/90 flex-1">{item.action}</p>
                  <span className={cn("text-[10px] font-semibold shrink-0", PRIORITY_COLOR[item.priority])}>
                    {item.priority}
                  </span>
                </div>
                {(item.owner || item.timeline) && (
                  <div className="flex gap-3 mt-0.5">
                    {item.owner && <span className="text-[10px] text-muted-foreground">Owner: {item.owner}</span>}
                    {item.timeline && <span className="text-[10px] text-muted-foreground">Timeline: {item.timeline}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Risks & Limitations */}
      {result.risksAndLimitations && result.risksAndLimitations.length > 0 && (
        <Section title="Risks & Limitations">
          <BulletList items={result.risksAndLimitations} />
        </Section>
      )}

      {/* Next Steps */}
      {result.nextSteps && result.nextSteps.length > 0 && (
        <Section title="Next Steps">
          <NumberedList items={result.nextSteps} />
        </Section>
      )}

      {/* Footer */}
      {result.usedFallback && (
        <p className="mt-3 text-[9px] text-muted-foreground/50">Analysis generated via fallback model.</p>
      )}
    </div>
  );
}
