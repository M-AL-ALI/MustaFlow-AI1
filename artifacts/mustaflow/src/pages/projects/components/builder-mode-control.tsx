import { useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, ChevronDown, Lock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useBuilderCreditCosts, getCreditCost } from "@/lib/builder-followup-submit";
import {
  getGetNabuflowBillingStateQueryKey,
  getListNabuflowPlansQueryKey,
  useGetNabuflowBillingState,
  useListNabuflowPlans,
} from "@workspace/api-client-react";
import {
  formatResetDate,
  nabuflowComboUnlockPlan,
  nabuflowDeepUnlockPlan,
} from "@/lib/nabuflow-billing";
import {
  BuilderDeepReasoningIcon,
  BuilderModeIcon,
  type BuilderAgentMode,
} from "@/components/builder-mode-icon";

export type { BuilderAgentMode } from "@/components/builder-mode-icon";

export const BUILDER_MODE_OPTIONS: ReadonlyArray<{
  mode: BuilderAgentMode;
  label: string;
  description: string;
}> = [
  { mode: "lite", label: "Lite", description: "Quick, minimal changes" },
  { mode: "eco", label: "Eco", description: "Balanced planning and clean typed code" },
  { mode: "power", label: "Power", description: "Deeper planning for production-ready work" },
  { mode: "pro", label: "Pro", description: "Deepest planning with strict review" },
];

function creditLabel(credits: number): string {
  return `${credits} ${credits === 1 ? "credit" : "credits"}`;
}

export function BuilderModeControl({
  mode,
  deepReasoning,
  disabled,
  onModeChange,
  onDeepReasoningChange,
}: {
  mode: BuilderAgentMode;
  deepReasoning: boolean;
  disabled: boolean;
  onModeChange: (mode: BuilderAgentMode) => void;
  onDeepReasoningChange: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const creditCosts = useBuilderCreditCosts();
  const selected = BUILDER_MODE_OPTIONS.find((option) => option.mode === mode)!;
  const selectedCost = getCreditCost(creditCosts, mode, deepReasoning);

  // NabuFlow engine-mode ladder — display only; the server gate stays the
  // sole authority. When enforcement is off, the user is exempt, or there is
  // no plan yet, the control behaves exactly as before.
  const { data: billing } = useGetNabuflowBillingState({
    query: {
      queryKey: getGetNabuflowBillingStateQueryKey(),
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });
  const { data: plansData } = useListNabuflowPlans({
    query: { queryKey: getListNabuflowPlansQueryKey(), staleTime: 5 * 60_000 },
  });
  const ladderActive = !!billing?.enforcementEnabled && !billing.exempt && !!billing.plan;
  const ladder = ladderActive ? billing!.plan!.ladder : null;
  const cycle = ladderActive ? (billing!.cycle ?? null) : null;
  const plans = plansData?.plans ?? [];

  const proLimit = ladder ? (ladder.proBuildsPerCycle ?? null) : null;
  const deepLimit = ladder ? (ladder.deepBuildsPerCycle ?? null) : null;
  const remPro = cycle?.remainingProBuilds ?? null;
  const remDeep = cycle?.remainingDeepBuilds ?? null;
  const resetShort = formatResetDate(cycle?.resetsAt);
  const resetTitle = resetShort ? `Resets on ${resetShort}` : undefined;

  const deepUnlock = nabuflowDeepUnlockPlan(plans);
  const comboUnlock = nabuflowComboUnlockPlan(plans);

  /** Deep is entirely off this plan (e.g. Orbit) — visible but locked. */
  const deepLockedByPlan = !!ladder && deepLimit === 0;
  /** Pro + Deep together is reserved for a higher tier (e.g. below Nova). */
  const comboLocked = !!ladder && mode === "pro" && !ladder.proDeepCombo;

  const deepDisabled = mode === "lite" || disabled || deepLockedByPlan || comboLocked;
  const deepMetered = !!ladder && deepLimit != null && deepLimit > 0;

  const triggerProCounter =
    ladderActive && mode === "pro" && proLimit != null
      ? `${remPro ?? 0} of ${proLimit} left`
      : null;
  const triggerDeepCounter =
    ladderActive && deepReasoning && deepMetered
      ? `Deep · ${remDeep ?? 0} of ${deepLimit} left`
      : null;

  const upgradeLink = comboLocked
    ? {
        href: `/billing/plans${comboUnlock ? `?highlight=${comboUnlock.id}` : ""}`,
        label: `Unlock Pro + Deep together on ${comboUnlock?.name ?? "a higher plan"}`,
        testId: "combo-upgrade-link",
      }
    : deepLockedByPlan && mode !== "lite"
      ? {
          href: `/billing/plans${deepUnlock ? `?highlight=${deepUnlock.id}` : ""}`,
          label: `Unlock Deep Reasoning on ${deepUnlock?.name ?? "a higher plan"}`,
          testId: "deep-upgrade-link",
        }
      : null;

  return (
    <div data-testid="builder-mode-picker" className="mt-2 px-3 min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-testid="builder-mode-trigger"
            aria-label={`Mode: ${selected.label}, ${creditLabel(selectedCost)}${
              triggerProCounter ? `, Pro ${triggerProCounter}` : ""
            }${triggerDeepCounter ? `, ${triggerDeepCounter}` : ""}`}
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors",
              "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <span className="text-muted-foreground">Mode</span>
            <BuilderModeIcon mode={mode} className="h-3 w-3" />
            <span className="truncate">
              {selected.label} · {creditLabel(selectedCost)}
            </span>
            {triggerProCounter && (
              <span
                title={resetTitle}
                data-testid="trigger-pro-counter"
                className={cn(
                  "shrink-0 rounded-full border px-1.5 py-px text-[9px] font-semibold",
                  remPro === 0
                    ? "border-amber-500/50 text-amber-500"
                    : "border-border text-muted-foreground",
                )}
              >
                {triggerProCounter}
              </span>
            )}
            {triggerDeepCounter && (
              <span
                title={resetTitle}
                data-testid="trigger-deep-counter"
                className={cn(
                  "shrink-0 rounded-full border px-1.5 py-px text-[9px] font-semibold",
                  remDeep === 0
                    ? "border-amber-500/50 text-amber-500"
                    : "border-border text-muted-foreground",
                )}
              >
                {triggerDeepCounter}
              </span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-[min(22rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-2"
          data-testid="builder-mode-panel"
        >
          <div className="px-1 pb-2">
            <p className="text-xs font-semibold text-foreground">Choose a mode</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Every mode can build a complete app. Higher modes spend more time planning and
              checking.
            </p>
          </div>

          <div className="space-y-1">
            {BUILDER_MODE_OPTIONS.map((option) => {
              const selectedMode = option.mode === mode;
              const isMeteredPro = option.mode === "pro" && ladderActive && proLimit != null;
              return (
                <button
                  key={option.mode}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onModeChange(option.mode);
                    if (option.mode === "lite") onDeepReasoningChange(false);
                    // Mirror the server's combo rule: picking Pro with Deep on
                    // when the plan lacks the combo would be rejected anyway.
                    if (option.mode === "pro" && deepReasoning && ladder && !ladder.proDeepCombo) {
                      onDeepReasoningChange(false);
                    }
                  }}
                  aria-pressed={selectedMode}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                    selectedMode
                      ? "border-primary/50 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-muted/60",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <BuilderModeIcon mode={option.mode} className="mt-0.5 h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-foreground">
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                    {isMeteredPro && (
                      <span
                        title={resetTitle}
                        data-testid="pro-mode-counter"
                        className={cn(
                          "mt-1 inline-block rounded-full border px-1.5 py-px text-[9px] font-semibold",
                          remPro === 0
                            ? "border-amber-500/50 text-amber-500"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {remPro ?? 0} of {proLimit} left this cycle
                        {resetShort ? ` · resets ${resetShort}` : ""}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 pt-0.5 text-[10px] font-medium text-foreground">
                    {creditLabel(getCreditCost(creditCosts, option.mode))}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              data-testid="deep-reasoning-toggle"
              disabled={deepDisabled}
              onClick={() => onDeepReasoningChange(!deepReasoning)}
              aria-pressed={deepReasoning}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                deepReasoning
                  ? "border-primary/50 bg-primary/10"
                  : "border-border hover:bg-muted/60",
                deepDisabled && "cursor-not-allowed opacity-40",
              )}
            >
              {deepLockedByPlan || comboLocked ? (
                <Lock className="h-4 w-4 text-muted-foreground" />
              ) : (
                <BuilderDeepReasoningIcon className="h-4 w-4" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-foreground">Deep Reasoning</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                  {mode === "lite"
                    ? "Available in Eco, Power, and Pro"
                    : comboLocked
                      ? `Pro + Deep together is a ${comboUnlock?.name ?? "top-tier"} exclusive`
                      : deepLockedByPlan
                        ? `Available from ${deepUnlock?.name ?? "a higher plan"} up`
                        : `Use the deepest planning pass · ${selected.label} becomes ${creditLabel(
                            getCreditCost(creditCosts, mode, true),
                          )}`}
                </span>
                {deepMetered && !comboLocked && mode !== "lite" && (
                  <span
                    title={resetTitle}
                    data-testid="deep-toggle-counter"
                    className={cn(
                      "mt-0.5 block text-[9px] font-semibold",
                      remDeep === 0 ? "text-amber-500" : "text-muted-foreground",
                    )}
                  >
                    {remDeep ?? 0} of {deepLimit} Deep builds left this cycle
                    {resetShort ? ` · resets ${resetShort}` : ""}
                  </span>
                )}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
                  deepReasoning ? "border-primary bg-primary" : "border-border bg-muted",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform",
                    deepReasoning ? "translate-x-[17px]" : "translate-x-0.5",
                  )}
                />
              </span>
            </button>

            {upgradeLink && (
              <Link
                href={upgradeLink.href}
                data-testid={upgradeLink.testId}
                className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/10 no-underline"
              >
                <span className="min-w-0 truncate">{upgradeLink.label}</span>
                <ArrowUpRight className="h-3 w-3 shrink-0" />
              </Link>
            )}

            <p className="px-3 pt-1.5 text-[9px] text-muted-foreground">
              Deep prices:{" "}
              {BUILDER_MODE_OPTIONS.filter((option) => option.mode !== "lite")
                .map(
                  (option) =>
                    `${option.label} ${creditLabel(getCreditCost(creditCosts, option.mode, true))}`,
                )
                .join(" · ")}
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
