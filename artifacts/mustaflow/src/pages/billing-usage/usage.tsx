// Billing & Usage — Usage dashboard. All charts derive from the same ledger
// rows (GET /billing/nabuflow/usage) and the billing state read model, so the
// numbers always match what was charged. Light/dark friendly, reduced-motion
// aware, cycle selector + CSV export.
import { useMemo, useState } from "react";
import { Download, Gauge } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  getListNabuflowUsageQueryKey,
  useListNabuflowUsage,
  useListProjects,
  type NabuflowUsageEvent,
} from "@workspace/api-client-react";
import { formatResetDate, formatUsdCents } from "@/lib/nabuflow-billing";
import { useBuilderCreditCosts, getCreditCost } from "@/lib/builder-followup-submit";
import { MeterBar, SectionCard, useNabuflowState, usePrefersReducedMotion } from "./shared";
import { filterUsageEventsForPreset, type UsageCyclePreset } from "./usage-cycle-filter";

const MODE_LABELS: Record<string, string> = {
  lite: "Lite",
  eco: "Eco",
  power: "Power",
  pro: "Pro",
};
const MODE_ORDER = ["lite", "eco", "power", "pro"] as const;
const MODE_COLORS: Record<string, string> = {
  lite: "#34d399",
  eco: "#38bdf8",
  power: "#a78bfa",
  pro: "#f59e0b",
};
const COLOR_SPEND = "#818cf8";
const COLOR_CREDITS = "#34d399";
const COLOR_BUILDS = "#818cf8";
const COLOR_DEEP = "#f43f5e";
const COLOR_STANDARD = "#64748b";
const COLOR_INCLUDED = "#38bdf8";
const COLOR_PAYG = "#f59e0b";
const COLOR_POOL = "#8b5cf6";

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shortDay(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function UsageSection() {
  const { data: state, isLoading: stateLoading } = useNabuflowState();
  const { data: usageData, isLoading: usageLoading } = useListNabuflowUsage(
    { limit: 200 },
    {
      query: {
        queryKey: getListNabuflowUsageQueryKey({ limit: 200 }),
        staleTime: 30_000,
        refetchInterval: 60_000,
      },
    },
  );
  const { data: projects } = useListProjects();
  const reducedMotion = usePrefersReducedMotion();
  const creditCosts = useBuilderCreditCosts();

  const [preset, setPreset] = useState<UsageCyclePreset>("current");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const cycle = state?.cycle ?? null;
  const sub = state?.subscription ?? null;
  const plan = state?.plan ?? null;
  const cap = state?.spendCap ?? null;
  const resetDate = formatResetDate(cycle?.resetsAt);

  const range = useMemo(() => {
    const now = new Date();
    const fallbackStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const fallbackEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const cs = sub?.currentCycleStart ? new Date(sub.currentCycleStart) : fallbackStart;
    const ce = sub?.currentCycleEnd ? new Date(sub.currentCycleEnd) : fallbackEnd;
    if (preset === "current") return { start: cs, end: ce };
    if (preset === "last") {
      const len = Math.max(ce.getTime() - cs.getTime(), 24 * 3600 * 1000);
      return { start: new Date(cs.getTime() - len), end: cs };
    }
    const s = customStart ? new Date(`${customStart}T00:00:00`) : cs;
    const e = customEnd ? new Date(`${customEnd}T23:59:59.999`) : now;
    return s.getTime() <= e.getTime() ? { start: s, end: e } : { start: e, end: s };
  }, [preset, customStart, customEnd, sub?.currentCycleStart, sub?.currentCycleEnd]);

  const allEvents = useMemo(() => usageData?.events ?? [], [usageData?.events]);

  const { events, reversedCount } = useMemo(() => {
    const inRange = filterUsageEventsForPreset(allEvents, {
      preset,
      currentCycleId: cycle?.id ?? null,
      start: range.start,
      end: range.end,
    });
    return {
      events: inRange.filter((e) => !e.reversedAt),
      reversedCount: inRange.filter((e) => !!e.reversedAt).length,
    };
  }, [allEvents, cycle?.id, preset, range]);

  const daily = useMemo(() => {
    const byDay = new Map<
      string,
      {
        builds: number;
        credits: number;
        included: number;
        overage: number;
        overageUsd: number;
        pool: number;
      }
    >();
    // Seed every day of the window (clamped to today) so charts have a full axis.
    const endClamp = Math.min(range.end.getTime(), Date.now() + 24 * 3600 * 1000);
    for (let t = range.start.getTime(); t < endClamp; t += 24 * 3600 * 1000) {
      byDay.set(dayKey(new Date(t)), {
        builds: 0,
        credits: 0,
        included: 0,
        overage: 0,
        overageUsd: 0,
        pool: 0,
      });
    }
    for (const e of events) {
      const key = dayKey(new Date(e.createdAt!));
      const row = byDay.get(key) ?? {
        builds: 0,
        credits: 0,
        included: 0,
        overage: 0,
        overageUsd: 0,
        pool: 0,
      };
      row.builds += 1;
      row.credits += e.credits;
      row.included += e.includedCredits;
      row.overage += e.overageCredits;
      row.overageUsd += e.overageUsdCents / 100;
      // Constellation seats: draws against the org's shared pool.
      row.pool += e.attribution === "pool" ? e.credits : 0;
      byDay.set(key, row);
    }
    let cumUsd = 0;
    let cumIncluded = 0;
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, v]) => {
        cumUsd += v.overageUsd;
        cumIncluded += v.included;
        return { day: key, ...v, cumUsd: Number(cumUsd.toFixed(2)), cumIncluded };
      });
  }, [events, range]);

  const modeTotals = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      const mode = e.engineMode ?? "eco";
      counts.set(mode, (counts.get(mode) ?? 0) + 1);
    }
    return MODE_ORDER.map((m) => ({
      mode: MODE_LABELS[m],
      count: counts.get(m) ?? 0,
      fill: MODE_COLORS[m],
    }));
  }, [events]);

  const deepStats = useMemo(() => {
    const deepEvents = events.filter((e) => e.deepReasoning);
    const deepCredits = deepEvents.reduce((s, e) => s + e.credits, 0);
    const deepUsd = deepEvents.reduce((s, e) => s + e.usdValueCents, 0);
    let baseCredits = 0;
    for (const e of deepEvents) {
      const mode = MODE_ORDER.includes((e.engineMode ?? "") as (typeof MODE_ORDER)[number])
        ? (e.engineMode as (typeof MODE_ORDER)[number])
        : "eco";
      baseCredits += getCreditCost(creditCosts, mode, false);
    }
    const surchargeCredits = Math.max(deepCredits - baseCredits, 0);
    const surchargeUsd =
      deepCredits > 0 ? Math.round(deepUsd * (surchargeCredits / deepCredits)) : 0;
    return {
      count: deepEvents.length,
      share: events.length > 0 ? (deepEvents.length / events.length) * 100 : 0,
      deepCredits,
      surchargeCredits,
      surchargeUsd,
    };
  }, [events, creditCosts]);

  const projectTotals = useMemo(() => {
    const nameById = new Map<number, string>((projects ?? []).map((p) => [p.id, p.name]));
    const byProject = new Map<string, { credits: number; usd: number }>();
    for (const e of events) {
      const name =
        e.projectId != null
          ? (nameById.get(e.projectId) ?? `Project #${e.projectId}`)
          : "No project";
      const row = byProject.get(name) ?? { credits: 0, usd: 0 };
      row.credits += e.credits;
      row.usd += e.usdValueCents / 100;
      byProject.set(name, row);
    }
    return [...byProject.entries()]
      .map(([name, v]) => ({ name, credits: v.credits, usd: Number(v.usd.toFixed(2)) }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 6);
  }, [events, projects]);

  const totals = useMemo(
    () => ({
      builds: events.length,
      credits: events.reduce((s, e) => s + e.credits, 0),
      included: events.reduce((s, e) => s + e.includedCredits, 0),
      overage: events.reduce((s, e) => s + e.overageCredits, 0),
      overageUsdCents: events.reduce((s, e) => s + e.overageUsdCents, 0),
      pool: events.reduce((s, e) => s + (e.attribution === "pool" ? e.credits : 0), 0),
    }),
    [events],
  );

  const exportCsv = () => {
    const cols = [
      "id",
      "createdAt",
      "source",
      "engineMode",
      "deepReasoning",
      "credits",
      "includedCredits",
      "overageCredits",
      "overageUsdCents",
      "usdValueCents",
      "attribution",
      "projectId",
      "taskId",
      "orgId",
      "description",
      "reversedAt",
    ] as const;
    const rowsInRange = allEvents.filter((e) => {
      if (!e.createdAt) return false;
      const t = new Date(e.createdAt).getTime();
      return t >= range.start.getTime() && t < range.end.getTime();
    });
    const lines = [
      cols.join(","),
      ...rowsInRange.map((e) => cols.map((c) => csvEscape((e as NabuflowUsageEvent)[c])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nabuflow-usage-${dayKey(range.start)}-to-${dayKey(range.end)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (stateLoading || usageLoading) {
    return (
      <div className="space-y-4" data-testid="usage-loading">
        <Skeleton className="h-10 w-full rounded-lg" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    );
  }

  const capUsd = (cap?.usdCents ?? 0) / 100;
  const empty = events.length === 0;
  const hasPool = totals.pool > 0;

  const presetBtn = (id: UsageCyclePreset, label: string) => (
    <button
      type="button"
      onClick={() => setPreset(id)}
      data-testid={`cycle-preset-${id}`}
      className={
        preset === id
          ? "rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground"
          : "rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      }
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4" data-testid="billing-usage-dashboard">
      {/* Toolbar: cycle selector + CSV export */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {presetBtn("current", "This cycle")}
          {presetBtn("last", "Last cycle")}
          {presetBtn("custom", "Custom")}
          {preset === "custom" && (
            <span className="ml-1 flex items-center gap-1.5">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                aria-label="Start date"
                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
              />
              <span className="text-[11px] text-muted-foreground">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                aria-label="End date"
                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
              />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {shortDay(dayKey(range.start))} – {shortDay(dayKey(range.end))} · {totals.builds} builds
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={allEvents.length === 0}
            data-testid="usage-export-csv"
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
          </Button>
        </div>
      </div>

      {(allEvents.length >= 200 || reversedCount > 0) && (
        <p className="text-[11px] text-muted-foreground">
          {allEvents.length >= 200 ? "Showing the most recent 200 ledger events. " : ""}
          {reversedCount > 0
            ? `${reversedCount} reversed charge${reversedCount === 1 ? "" : "s"} excluded from charts (included in the CSV).`
            : ""}
        </p>
      )}

      {/* Metered counters (always the live current cycle) */}
      {plan && cycle && (
        <SectionCard
          title="Metered Pro / Deep counters"
          description={
            resetDate
              ? `Live counters for the current cycle — reset on ${resetDate} and never roll over.`
              : "Live counters reset each cycle and never roll over."
          }
          testId="usage-counters"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {plan.ladder.proBuildsPerCycle == null ? (
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-foreground">Pro builds</p>
                <Badge variant="secondary">Unlimited</Badge>
              </div>
            ) : (
              <MeterBar
                label="Pro builds"
                used={cycle.proBuildsUsed}
                total={plan.ladder.proBuildsPerCycle}
                formatValue={() =>
                  `${cycle.remainingProBuilds ?? 0} of ${plan.ladder.proBuildsPerCycle} left`
                }
              />
            )}
            {plan.ladder.deepBuildsPerCycle == null ? (
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-foreground">Deep-reasoning builds</p>
                <Badge variant="secondary">Unlimited</Badge>
              </div>
            ) : plan.ladder.deepBuildsPerCycle === 0 ? (
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Deep-reasoning builds</p>
                <Badge variant="outline">Not on this plan</Badge>
              </div>
            ) : (
              <MeterBar
                label="Deep-reasoning builds"
                used={cycle.deepBuildsUsed}
                total={plan.ladder.deepBuildsPerCycle}
                formatValue={() =>
                  `${cycle.remainingDeepBuilds ?? 0} of ${plan.ladder.deepBuildsPerCycle} left`
                }
              />
            )}
          </div>
        </SectionCard>
      )}

      {empty ? (
        <SectionCard testId="usage-empty">
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Gauge className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No usage in this window</p>
            <p className="text-xs text-muted-foreground">
              Run a build and it'll show up here within a minute.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {/* 1. Spend vs cap */}
            <SectionCard
              title="Spend vs cap"
              description={
                resetDate
                  ? `Pay-as-you-go spend this window · cap resets ${resetDate}`
                  : "Pay-as-you-go spend this window"
              }
              testId="chart-spend-vs-cap"
            >
              <ChartContainer
                config={
                  { cumUsd: { label: "Spend ($)", color: COLOR_SPEND } } satisfies ChartConfig
                }
                className="h-48 w-full"
              >
                <AreaChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.25} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={shortDay}
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    minTickGap={28}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    width={40}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent labelFormatter={(l) => shortDay(String(l))} />}
                  />
                  {capUsd > 0 && (
                    <ReferenceLine
                      y={capUsd}
                      stroke="#ef4444"
                      strokeDasharray="4 4"
                      label={{
                        value: `Cap $${capUsd}`,
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "#ef4444",
                      }}
                    />
                  )}
                  <Area
                    dataKey="cumUsd"
                    type="monotone"
                    stroke={COLOR_SPEND}
                    fill={COLOR_SPEND}
                    fillOpacity={0.18}
                    isAnimationActive={!reducedMotion}
                  />
                </AreaChart>
              </ChartContainer>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {formatUsdCents(totals.overageUsdCents)} spent beyond included credits in this
                window.
              </p>
            </SectionCard>

            {/* 2. Credits remaining vs included */}
            <SectionCard
              title="Included credits"
              description="Cumulative included credits used across the window"
              testId="chart-credits"
            >
              <ChartContainer
                config={
                  {
                    cumIncluded: { label: "Included used", color: COLOR_CREDITS },
                  } satisfies ChartConfig
                }
                className="h-48 w-full"
              >
                <AreaChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.25} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={shortDay}
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    minTickGap={28}
                  />
                  <YAxis tickLine={false} axisLine={false} fontSize={10} width={44} />
                  <ChartTooltip
                    content={<ChartTooltipContent labelFormatter={(l) => shortDay(String(l))} />}
                  />
                  {preset === "current" && cycle && (
                    <ReferenceLine
                      y={cycle.includedCredits}
                      stroke={COLOR_CREDITS}
                      strokeDasharray="4 4"
                      label={{
                        value: "Included",
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: COLOR_CREDITS,
                      }}
                    />
                  )}
                  <Area
                    dataKey="cumIncluded"
                    type="monotone"
                    stroke={COLOR_CREDITS}
                    fill={COLOR_CREDITS}
                    fillOpacity={0.18}
                    isAnimationActive={!reducedMotion}
                  />
                </AreaChart>
              </ChartContainer>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {preset === "current" && cycle
                  ? `${cycle.remainingIncludedCredits.toLocaleString()} of ${cycle.includedCredits.toLocaleString()} included credits remaining · resets ${resetDate ?? "next cycle"}.`
                  : `${totals.included.toLocaleString()} included credits used in this window.`}
              </p>
            </SectionCard>

            {/* 3. Builds over time */}
            <SectionCard title="Builds over time" testId="chart-builds">
              <ChartContainer
                config={{ builds: { label: "Builds", color: COLOR_BUILDS } } satisfies ChartConfig}
                className="h-48 w-full"
              >
                <BarChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.25} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={shortDay}
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    minTickGap={28}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    width={30}
                    allowDecimals={false}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent labelFormatter={(l) => shortDay(String(l))} />}
                  />
                  <Bar
                    dataKey="builds"
                    fill={COLOR_BUILDS}
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={!reducedMotion}
                  />
                </BarChart>
              </ChartContainer>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {totals.builds} builds in this window.
              </p>
            </SectionCard>

            {/* 4. Builds by engine mode (required) */}
            <SectionCard title="Builds by engine mode" testId="chart-modes">
              <ChartContainer
                config={{ count: { label: "Builds" } } satisfies ChartConfig}
                className="h-48 w-full"
              >
                <BarChart data={modeTotals} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.25} />
                  <XAxis dataKey="mode" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    width={30}
                    allowDecimals={false}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={!reducedMotion}>
                    {modeTotals.map((m) => (
                      <Cell key={m.mode} fill={m.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {modeTotals.map((m) => (
                  <span
                    key={m.mode}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.fill }} />
                    {m.mode}: {m.count}
                  </span>
                ))}
              </div>
            </SectionCard>

            {/* 5. Deep reasoning share + flat-price difference */}
            <SectionCard
              title="Deep-reasoning builds"
              description="Count, share and the Deep portion of each flat build price in this window"
              testId="chart-deep"
            >
              <div className="flex items-center gap-4">
                <ChartContainer
                  config={{ value: { label: "Builds" } } satisfies ChartConfig}
                  className="h-40 w-40 shrink-0"
                >
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                    <Pie
                      data={[
                        { name: "Deep", value: deepStats.count, fill: COLOR_DEEP },
                        {
                          name: "Standard",
                          value: Math.max(totals.builds - deepStats.count, 0),
                          fill: COLOR_STANDARD,
                        },
                      ]}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={34}
                      outerRadius={56}
                      strokeWidth={2}
                      isAnimationActive={!reducedMotion}
                    />
                  </PieChart>
                </ChartContainer>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-2xl font-bold tabular-nums text-foreground">
                    {deepStats.count}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      deep builds · {deepStats.share.toFixed(0)}% of all builds
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Deep price difference:{" "}
                    <span className="font-semibold text-foreground">
                      ≈{deepStats.surchargeCredits.toLocaleString()} credits (
                      {formatUsdCents(deepStats.surchargeUsd)})
                    </span>{" "}
                    within the flat Deep build price.
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Deep builds consumed {deepStats.deepCredits.toLocaleString()} credits total.
                    Each Deep build is one flat charge; this comparison is not a separate surcharge.
                  </p>
                </div>
              </div>
            </SectionCard>

            {/* 6. Cost by project */}
            <SectionCard title="Cost by project" testId="chart-projects">
              {projectTotals.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No project usage in this window.
                </p>
              ) : (
                <ChartContainer
                  config={
                    { credits: { label: "Credits", color: COLOR_SPEND } } satisfies ChartConfig
                  }
                  className="h-48 w-full"
                >
                  <BarChart
                    data={projectTotals}
                    layout="vertical"
                    margin={{ left: 8, right: 12, top: 4 }}
                  >
                    <CartesianGrid horizontal={false} strokeOpacity={0.25} />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      fontSize={10}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tickLine={false}
                      axisLine={false}
                      fontSize={10}
                      width={110}
                      tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="credits"
                      fill={COLOR_SPEND}
                      radius={[0, 3, 3, 0]}
                      isAnimationActive={!reducedMotion}
                    />
                  </BarChart>
                </ChartContainer>
              )}
            </SectionCard>
          </div>

          {/* 7. Pay-as-you-go vs included (full width) */}
          <SectionCard
            title="Pay-as-you-go vs included"
            description="Credits drawn from your included bucket vs charged as overage, per day"
            testId="chart-payg"
          >
            <ChartContainer
              config={
                {
                  included: { label: "Included", color: COLOR_INCLUDED },
                  overage: { label: "Pay-as-you-go", color: COLOR_PAYG },
                  ...(hasPool ? { pool: { label: "Org pool", color: COLOR_POOL } } : {}),
                } satisfies ChartConfig
              }
              className="h-52 w-full"
            >
              <BarChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.25} />
                <XAxis
                  dataKey="day"
                  tickFormatter={shortDay}
                  tickLine={false}
                  axisLine={false}
                  fontSize={10}
                  minTickGap={28}
                />
                <YAxis tickLine={false} axisLine={false} fontSize={10} width={44} />
                <ChartTooltip
                  content={<ChartTooltipContent labelFormatter={(l) => shortDay(String(l))} />}
                />
                {hasPool && (
                  <Bar
                    dataKey="pool"
                    stackId="c"
                    fill={COLOR_POOL}
                    isAnimationActive={!reducedMotion}
                  />
                )}
                <Bar
                  dataKey="included"
                  stackId="c"
                  fill={COLOR_INCLUDED}
                  isAnimationActive={!reducedMotion}
                />
                <Bar
                  dataKey="overage"
                  stackId="c"
                  fill={COLOR_PAYG}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={!reducedMotion}
                />
              </BarChart>
            </ChartContainer>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {totals.included.toLocaleString()} included credits ·{" "}
              {totals.overage.toLocaleString()} pay-as-you-go credits (
              {formatUsdCents(totals.overageUsdCents)})
              {hasPool
                ? ` · ${totals.pool.toLocaleString()} credits drawn from your organization's pool`
                : ""}{" "}
              in this window.
            </p>
          </SectionCard>
        </>
      )}
    </div>
  );
}
