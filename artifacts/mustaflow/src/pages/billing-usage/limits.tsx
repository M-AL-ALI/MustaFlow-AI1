// Billing & Usage — Spending limits: monthly cap editor (within tier bounds)
// plus warning-threshold guardrails.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  getGetNabuflowBillingStateQueryKey,
  useUpdateNabuflowSpendCap,
} from "@workspace/api-client-react";
import { useClerkUser } from "@/lib/clerk-safe";
import { formatUsdCents } from "@/lib/nabuflow-billing";
import {
  getDisabledSpendWarnings,
  MeterBar,
  SectionCard,
  setSpendWarningEnabled,
  SPEND_WARNING_THRESHOLDS,
  useNabuflowState,
} from "./shared";

function apiErrorMessage(err: unknown): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string") return data.error;
  return "Something went wrong. Please try again.";
}

export function LimitsSection() {
  const { data: state, isLoading } = useNabuflowState();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useClerkUser();
  const capMutation = useUpdateNabuflowSpendCap();

  const cap = state?.spendCap ?? null;
  const cycle = state?.cycle ?? null;
  const plan = state?.plan ?? null;

  const [input, setInput] = useState("");
  const [disabledWarnings, setDisabledWarnings] = useState<number[]>([]);

  useEffect(() => {
    if (cap) setInput(String(cap.usdCents / 100));
  }, [cap?.usdCents]); // eslint-disable-line react-hooks/exhaustive-deps -- sync from server value only

  useEffect(() => {
    setDisabledWarnings(getDisabledSpendWarnings(user?.id));
  }, [user?.id]);

  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl" data-testid="limits-loading" />;
  }

  if (!plan || !cap) {
    return (
      <SectionCard title="Spending limits" testId="limits-no-plan">
        <p className="text-sm text-muted-foreground">
          Spending limits apply once you're on a NabuFlow plan — they cap how much pay-as-you-go
          overage can be charged per cycle.
        </p>
        <Button asChild size="sm" className="mt-3">
          <Link href="/billing/plans">See plans</Link>
        </Button>
      </SectionCard>
    );
  }

  const parsed = Number.parseFloat(input);
  const parsedCents = Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
  const inBounds = Number.isFinite(parsedCents) && parsedCents >= 0 && parsedCents <= cap.maxUsdCents;
  const unchanged = Number.isFinite(parsedCents) && parsedCents === cap.usdCents;

  const saveCap = (cents: number | null) => {
    capMutation.mutate(
      { data: { spendCapUsdCents: cents } },
      {
        onSuccess: (res) => {
          const effective = res.effectiveSpendCapUsdCents ?? res.spendCapUsdCents ?? cents ?? cap.defaultUsdCents;
          toast({
            title: "Spending limit updated",
            description: `Pay-as-you-go overage is now capped at ${formatUsdCents(effective)} per cycle.`,
          });
          void queryClient.invalidateQueries({ queryKey: getGetNabuflowBillingStateQueryKey() });
        },
        onError: (err) =>
          toast({ title: "Couldn't update the limit", description: apiErrorMessage(err), variant: "destructive" }),
      },
    );
  };

  const toggleWarning = (threshold: number, enabled: boolean) => {
    setSpendWarningEnabled(user?.id, threshold, enabled);
    setDisabledWarnings(getDisabledSpendWarnings(user?.id));
  };

  return (
    <div className="space-y-4" data-testid="billing-limits">
      <SectionCard
        title="Monthly spending cap"
        description="Hard ceiling for pay-as-you-go overage per cycle — builds pause when it's reached, nothing is charged beyond it."
        testId="limits-cap"
      >
        {cycle && (
          <div className="mb-4">
            <MeterBar
              label="Used this cycle"
              used={cycle.overageUsdCents}
              total={cap.usdCents}
              formatValue={(u, t) => `${formatUsdCents(u)} of ${formatUsdCents(t)}`}
            />
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="spend-cap-input" className="mb-1 block text-xs font-medium text-foreground">
              Cap (USD per cycle)
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                id="spend-cap-input"
                type="number"
                min={0}
                max={cap.maxUsdCents / 100}
                step={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="w-32"
                data-testid="spend-cap-input"
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={!inBounds || unchanged || capMutation.isPending}
            onClick={() => saveCap(parsedCents)}
            data-testid="spend-cap-save"
          >
            {capMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save limit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={capMutation.isPending || cap.usdCents === cap.defaultUsdCents}
            onClick={() => saveCap(null)}
            data-testid="spend-cap-reset"
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset to plan default
          </Button>
        </div>

        <p className="mt-2 text-[11px] text-muted-foreground">
          Your {plan.name} plan allows between $0 and {formatUsdCents(cap.maxUsdCents)} — the plan
          default is {formatUsdCents(cap.defaultUsdCents)}. A $0 cap disables pay-as-you-go overage
          entirely.
        </p>
        {!inBounds && input !== "" && (
          <p className="mt-1 text-[11px] text-destructive" data-testid="spend-cap-error">
            Enter an amount between $0 and {formatUsdCents(cap.maxUsdCents)}.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Warning guardrails"
        description="Show a heads-up banner on your billing overview as spend approaches the cap. Billing alerts are always recorded server-side either way."
        testId="limits-warnings"
      >
        <div className="divide-y divide-border/60">
          {SPEND_WARNING_THRESHOLDS.map((t) => (
            <div key={t} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
              <div>
                <p className="text-xs font-medium text-foreground">Warn at {t}% of cap</p>
                <p className="text-[11px] text-muted-foreground">
                  {t === 100
                    ? "When the cap is fully used and builds pause"
                    : `Around ${formatUsdCents((cap.usdCents * t) / 100)} at your current cap`}
                </p>
              </div>
              <Switch
                checked={!disabledWarnings.includes(t)}
                onCheckedChange={(checked) => toggleWarning(t, checked)}
                aria-label={`Warn at ${t}% of cap`}
                data-testid={`warn-toggle-${t}`}
              />
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
