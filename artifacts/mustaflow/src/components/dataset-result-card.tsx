import { useState } from "react";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VaultSaveDialog } from "@/components/vault-save-dialog";
import { cn } from "@/lib/utils";
import type {
  DatasetAnalysisResult,
  ImpactLevel,
  HealthScore,
  FinancialImpact,
  OperationalImpact,
  CustomerImpact,
  WhyThisMatters,
  EnhancedRecommendation,
  StrategicRoadmap,
  EnhancedRisk,
  RoadmapItem,
} from "@/types/dataset-analysis";

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

const HEALTH_COLOR: Record<HealthScore["category"], string> = {
  Excellent: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10",
  Good: "text-green-400 border-green-400/40 bg-green-400/10",
  "Needs Attention": "text-amber-400 border-amber-400/40 bg-amber-400/10",
  "High Risk": "text-orange-400 border-orange-400/40 bg-orange-400/10",
  Critical: "text-red-400 border-red-400/40 bg-red-400/10",
};

const IMPACT_COLOR: Record<ImpactLevel, string> = {
  Low: "text-muted-foreground",
  Moderate: "text-amber-400",
  High: "text-orange-400",
  Critical: "text-red-400",
};

const IMPACT_BG: Record<ImpactLevel, string> = {
  Low: "bg-muted/20 border-border/40",
  Moderate: "bg-amber-400/10 border-amber-400/30",
  High: "bg-orange-400/10 border-orange-400/30",
  Critical: "bg-red-400/10 border-red-400/30",
};

const REC_PRIORITY_COLOR: Record<EnhancedRecommendation["priority"], string> = {
  Critical: "text-red-400",
  High: "text-orange-400",
  Medium: "text-amber-400",
  Low: "text-muted-foreground",
};

const RISK_LEVEL_COLOR: Record<EnhancedRisk["riskLevel"], string> = {
  Low: "text-muted-foreground",
  Medium: "text-amber-400",
  High: "text-orange-400",
  Critical: "text-red-400",
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
          <span className="shrink-0 min-w-[16px] font-semibold text-[hsl(265_85%_65%)]">
            {i + 1}.
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function ScoreBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground w-6 text-right">{score}</span>
    </div>
  );
}

function ImpactBadge({ level }: { level: ImpactLevel }) {
  return (
    <span
      className={cn(
        "inline-block text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border",
        IMPACT_BG[level],
        IMPACT_COLOR[level],
      )}
    >
      {level}
    </span>
  );
}

function HealthScoreSection({ hs }: { hs: HealthScore }) {
  return (
    <Section title="Overall Health Score">
      <div
        className={cn(
          "rounded-lg border px-3 py-2.5 flex items-start gap-3",
          HEALTH_COLOR[hs.category],
        )}
      >
        <div className="shrink-0 text-center">
          <p className="text-2xl font-bold leading-none">{hs.score}</p>
          <p className="text-[9px] font-medium mt-0.5 uppercase tracking-wide">/100</p>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold">{hs.category}</p>
          <p className="text-[10px] mt-0.5 opacity-80 leading-relaxed">{hs.explanation}</p>
        </div>
      </div>
    </Section>
  );
}

function WhyThisMattersSection({ wtm }: { wtm: WhyThisMatters }) {
  const items: { label: string; text: string }[] = [
    { label: "Leadership Rationale", text: wtm.leadershipRationale },
    { label: "Consequences of Inaction", text: wtm.consequencesOfInaction },
    { label: "Strategic Implications", text: wtm.strategicImplications },
  ];
  if (wtm.competitiveImplications) {
    items.push({ label: "Competitive Implications", text: wtm.competitiveImplications });
  }
  return (
    <Section title="Why This Matters">
      <div className="space-y-2">
        {items.map(({ label, text }) => (
          <div key={label} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-[hsl(265_85%_65%)] mb-0.5">
              {label}
            </p>
            <p className="text-xs text-foreground/85 leading-relaxed">{text}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function FinancialImpactSection({ fi }: { fi: FinancialImpact }) {
  const CONF_COLOR: Record<FinancialImpact["confidence"], string> = {
    Low: "text-red-400 border-red-400/30 bg-red-400/10",
    Medium: "text-amber-400 border-amber-400/30 bg-amber-400/10",
    High: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  };
  const rows: { label: string; value: string }[] = [];
  if (fi.costOfIssues) rows.push({ label: "Cost of Current Issues", value: fi.costOfIssues });
  if (fi.savingsOpportunity)
    rows.push({ label: "Savings Opportunity", value: fi.savingsOpportunity });
  if (fi.revenueOpportunity)
    rows.push({ label: "Revenue Opportunity", value: fi.revenueOpportunity });
  if (fi.wasteReduction) rows.push({ label: "Waste Reduction", value: fi.wasteReduction });

  return (
    <Section title="Financial Impact Assessment">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] text-muted-foreground">Confidence:</span>
        <span
          className={cn(
            "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border",
            CONF_COLOR[fi.confidence],
          )}
        >
          {fi.confidence}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex items-start justify-between gap-2 text-xs">
              <span className="text-muted-foreground shrink-0">{label}</span>
              <span className="text-foreground/85 font-medium text-right">{value}</span>
            </div>
          ))}
        </div>
      )}
      {fi.notes && <p className="mt-2 text-[10px] text-muted-foreground/70 italic">{fi.notes}</p>}
    </Section>
  );
}

function ImpactGrid({
  dims,
}: {
  dims: { name: string; dim: { level: ImpactLevel; explanation: string } | undefined }[];
}) {
  const present = dims.filter((d) => d.dim !== undefined);
  if (!present.length) return null;
  return (
    <div className="space-y-1.5 mt-1">
      {present.map(({ name, dim }) => (
        <div key={name} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <p className="text-[10px] font-semibold text-foreground">{name}</p>
            <ImpactBadge level={dim!.level} />
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{dim!.explanation}</p>
        </div>
      ))}
    </div>
  );
}

function OperationalImpactSection({ oi }: { oi: OperationalImpact }) {
  return (
    <Section title="Operational Impact">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] text-muted-foreground">Overall:</span>
        <ImpactBadge level={oi.overallLevel} />
        {oi.summary && <p className="text-[10px] text-muted-foreground">{oi.summary}</p>}
      </div>
      <ImpactGrid
        dims={[
          { name: "Productivity", dim: oi.productivity },
          { name: "Throughput", dim: oi.throughput },
          { name: "Downtime", dim: oi.downtime },
          { name: "Labor", dim: oi.labor },
          { name: "Quality", dim: oi.quality },
          { name: "Capacity", dim: oi.capacity },
        ]}
      />
    </Section>
  );
}

function CustomerImpactSection({ ci }: { ci: CustomerImpact }) {
  return (
    <Section title="Customer Impact">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] text-muted-foreground">Overall:</span>
        <ImpactBadge level={ci.overallLevel} />
        {ci.summary && <p className="text-[10px] text-muted-foreground">{ci.summary}</p>}
      </div>
      <ImpactGrid
        dims={[
          { name: "Customer Experience", dim: ci.experience },
          { name: "Service", dim: ci.service },
          { name: "Delivery", dim: ci.delivery },
          { name: "Product Quality", dim: ci.productQuality },
          { name: "Reputation", dim: ci.reputation },
        ]}
      />
    </Section>
  );
}

function EnhancedRecommendationsSection({ recs }: { recs: EnhancedRecommendation[] }) {
  return (
    <Section title="Prioritized Recommendations">
      <div className="space-y-2">
        {recs.map((r, i) => (
          <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-foreground/90 flex-1">{r.recommendation}</p>
              <span
                className={cn(
                  "text-[9px] font-semibold uppercase shrink-0 mt-0.5",
                  REC_PRIORITY_COLOR[r.priority],
                )}
              >
                {r.priority}
              </span>
            </div>
            <div className="mt-1.5 space-y-1">
              <div className="flex items-center gap-1">
                <span className="text-[9px] text-muted-foreground w-14 shrink-0">Impact</span>
                <ScoreBar score={r.impactScore} color="bg-[hsl(265_85%_65%)]" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] text-muted-foreground w-14 shrink-0">Effort</span>
                <ScoreBar score={r.effortScore} color="bg-amber-400" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] text-muted-foreground w-14 shrink-0">Confidence</span>
                <ScoreBar score={r.confidenceScore} color="bg-emerald-400" />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">
              <span className="font-medium text-foreground/70">Benefit:</span> {r.expectedBenefit}
            </p>
            <div className="flex gap-3 mt-0.5">
              <span className="text-[10px] text-muted-foreground">Timeline: {r.timeline}</span>
              <span className="text-[10px] text-muted-foreground">Difficulty: {r.difficulty}</span>
              <span className="text-[10px] text-muted-foreground">Confidence: {r.confidence}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function RoadmapPhase({
  label,
  items,
  color,
}: {
  label: string;
  items: RoadmapItem[];
  color: string;
}) {
  if (!items.length) return null;
  return (
    <div>
      <p className={cn("text-[9px] font-semibold uppercase tracking-wide mb-1", color)}>{label}</p>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-foreground/90 flex-1">{item.action}</p>
              <span
                className={cn(
                  "text-[9px] font-semibold shrink-0 mt-0.5",
                  REC_PRIORITY_COLOR[item.priority],
                )}
              >
                {item.priority}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              <span className="font-medium">Outcome:</span> {item.expectedOutcome}
            </p>
            {item.owner && <p className="text-[10px] text-muted-foreground">Owner: {item.owner}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function StrategicRoadmapSection({ sr }: { sr: StrategicRoadmap }) {
  return (
    <Section title="Strategic Roadmap">
      <div className="space-y-3">
        <RoadmapPhase label="Immediate — 0–30 Days" items={sr.immediate} color="text-red-400" />
        <RoadmapPhase
          label="Short-term — 30–60 Days"
          items={sr.shortTerm}
          color="text-orange-400"
        />
        <RoadmapPhase
          label="Medium-term — 60–90 Days"
          items={sr.mediumTerm}
          color="text-amber-400"
        />
        <RoadmapPhase
          label="Strategic — 90+ Days"
          items={sr.strategic}
          color="text-[hsl(265_85%_65%)]"
        />
      </div>
    </Section>
  );
}

function EnhancedRisksSection({ risks }: { risks: EnhancedRisk[] }) {
  return (
    <Section title="Risk Assessment">
      <div className="space-y-1.5">
        {risks.map((r, i) => (
          <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-foreground/90 flex-1">{r.risk}</p>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[10px] font-bold text-foreground/70">{r.riskScore}</span>
                <span
                  className={cn(
                    "text-[9px] font-semibold uppercase tracking-wide",
                    RISK_LEVEL_COLOR[r.riskLevel],
                  )}
                >
                  {r.riskLevel}
                </span>
              </div>
            </div>
            <div className="flex gap-3 mt-0.5">
              <span className="text-[10px] text-muted-foreground">
                Probability: <span className="text-foreground/70">{r.probability}</span>
              </span>
              <span className="text-[10px] text-muted-foreground">
                Impact: <span className="text-foreground/70">{r.impact}</span>
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              <span className="font-medium text-foreground/60">Mitigation:</span> {r.mitigation}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function DatasetResultCard({ result }: DatasetResultCardProps) {
  const dp = result.datasetProfile;
  const [vaultOpen, setVaultOpen] = useState(false);

  const vaultContent = [
    result.summary ? `## Summary\n${result.summary}` : "",
    result.keyFindings && result.keyFindings.length > 0
      ? `## Key Findings\n${result.keyFindings.map((k: string) => `- ${k}`).join("\n")}`
      : "",
    result.recommendations && result.recommendations.length > 0
      ? `## Recommendations\n${result.recommendations.map((r) => `- ${r}`).join("\n")}`
      : "",
    result.actionPlan && result.actionPlan.length > 0
      ? `## Action Plan\n${result.actionPlan.map((a) => `- ${a.action} [${a.priority}]${a.owner ? ` — ${a.owner}` : ""}${a.timeline ? ` by ${a.timeline}` : ""}`).join("\n")}`
      : "",
    result.nextSteps && result.nextSteps.length > 0
      ? `## Next Steps\n${result.nextSteps.map((s) => `- ${s}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

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

      {/* Health Score — prominent position */}
      {result.healthScore && <HealthScoreSection hs={result.healthScore} />}

      {/* Key Findings */}
      {result.keyFindings && result.keyFindings.length > 0 && (
        <Section title="Key Findings">
          <BulletList items={result.keyFindings} />
        </Section>
      )}

      {/* Why This Matters — after key findings */}
      {result.whyThisMatters && <WhyThisMattersSection wtm={result.whyThisMatters} />}

      {/* KPI Gaps */}
      {result.kpiGaps && result.kpiGaps.length > 0 && (
        <Section title="KPI Gaps">
          <div className="space-y-1.5">
            {result.kpiGaps.map((kpi, i) => (
              <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
                <p className="text-xs font-medium text-foreground">{kpi.metric}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Current: <span className="text-foreground/80">{kpi.current}</span>
                  </span>
                  {kpi.target && (
                    <span className="text-[10px] text-muted-foreground">
                      Target: <span className="text-foreground/80">{kpi.target}</span>
                    </span>
                  )}
                  {kpi.gap && (
                    <span className="text-[10px] text-muted-foreground">
                      Gap: <span className="text-foreground/80">{kpi.gap}</span>
                    </span>
                  )}
                  {kpi.trend && (
                    <span className="text-[10px] text-muted-foreground">
                      Trend: <span className="text-foreground/80">{kpi.trend}</span>
                    </span>
                  )}
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
                  <span
                    className={cn(
                      "shrink-0 font-bold",
                      t.direction === "up"
                        ? "text-green-400"
                        : t.direction === "down"
                          ? "text-red-400"
                          : "text-muted-foreground",
                    )}
                  >
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
                <span className="shrink-0 w-4 text-[10px] text-muted-foreground text-right">
                  {i + 1}.
                </span>
                <span className="flex-1 truncate text-foreground/85">{p.label}</span>
                <span className="shrink-0 font-medium text-foreground/80">
                  {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
                </span>
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
                  <li key={i} className="text-xs text-foreground/85 pl-2">
                    {why}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {Object.keys(result.rootCauseAnalysis.fishbone).length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] font-medium text-muted-foreground mb-1">
                Fishbone Categories
              </p>
              <div className="space-y-1">
                {Object.entries(result.rootCauseAnalysis.fishbone).map(([category, causes]) => (
                  <div key={category}>
                    <span className="text-[10px] font-semibold text-[hsl(265_85%_65%)]">
                      {category}:{" "}
                    </span>
                    <span className="text-xs text-foreground/80">{causes.join("; ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.rootCauseAnalysis.likelyCauses.length > 0 && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-1">
                Most Likely Causes
              </p>
              <BulletList items={result.rootCauseAnalysis.likelyCauses} />
            </div>
          )}
        </Section>
      )}

      {/* Financial Impact */}
      {result.financialImpact && <FinancialImpactSection fi={result.financialImpact} />}

      {/* Operational Impact */}
      {result.operationalImpact && <OperationalImpactSection oi={result.operationalImpact} />}

      {/* Customer Impact */}
      {result.customerImpact && <CustomerImpactSection ci={result.customerImpact} />}

      {/* Recommendations — plain list */}
      {result.recommendations && result.recommendations.length > 0 && (
        <Section title="Recommendations">
          <NumberedList items={result.recommendations} />
        </Section>
      )}

      {/* Enhanced Recommendations */}
      {result.enhancedRecommendations && result.enhancedRecommendations.length > 0 && (
        <EnhancedRecommendationsSection recs={result.enhancedRecommendations} />
      )}

      {/* Action Plan */}
      {result.actionPlan && result.actionPlan.length > 0 && (
        <Section title="Action Plan">
          <div className="space-y-1.5">
            {result.actionPlan.map((item, i) => (
              <div key={i} className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-foreground/90 flex-1">{item.action}</p>
                  <span
                    className={cn(
                      "text-[10px] font-semibold shrink-0",
                      PRIORITY_COLOR[item.priority],
                    )}
                  >
                    {item.priority}
                  </span>
                </div>
                {(item.owner || item.timeline) && (
                  <div className="flex gap-3 mt-0.5">
                    {item.owner && (
                      <span className="text-[10px] text-muted-foreground">Owner: {item.owner}</span>
                    )}
                    {item.timeline && (
                      <span className="text-[10px] text-muted-foreground">
                        Timeline: {item.timeline}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Risks & Limitations — plain list */}
      {result.risksAndLimitations && result.risksAndLimitations.length > 0 && (
        <Section title="Risks & Limitations">
          <BulletList items={result.risksAndLimitations} />
        </Section>
      )}

      {/* Enhanced Risks */}
      {result.enhancedRisks && result.enhancedRisks.length > 0 && (
        <EnhancedRisksSection risks={result.enhancedRisks} />
      )}

      {/* Next Steps */}
      {result.nextSteps && result.nextSteps.length > 0 && (
        <Section title="Next Steps">
          <NumberedList items={result.nextSteps} />
        </Section>
      )}

      {/* Strategic Roadmap */}
      {result.strategicRoadmap && <StrategicRoadmapSection sr={result.strategicRoadmap} />}

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-border/40 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1.5"
          onClick={() => setVaultOpen(true)}
        >
          <BookOpen className="h-3.5 w-3.5" />
          Save to Knowledge Vault
        </Button>
        {result.usedFallback && (
          <p className="text-[9px] text-muted-foreground/50 ml-auto">
            Analysis generated via fallback model.
          </p>
        )}
      </div>

      <VaultSaveDialog
        open={vaultOpen}
        onOpenChange={setVaultOpen}
        defaults={{
          title: result.datasetProfile?.sheetName
            ? `Dataset Analysis — ${result.datasetProfile.sheetName}`
            : "Dataset Analysis",
          category: "REPORT",
          summary: result.summary ?? "Dataset analysis result.",
          content: (vaultContent || result.summary) ?? "",
          tags: ["dataset-analysis"],
          sourceType: "DATASET_ANALYSIS",
        }}
      />
    </div>
  );
}
