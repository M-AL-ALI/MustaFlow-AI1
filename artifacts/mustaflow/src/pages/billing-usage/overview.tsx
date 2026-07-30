// Billing & Usage — Overview: plan, credits, spend vs cap, metered modes,
// card on file, quick actions and recent billing activity.
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bell,
  CreditCard,
  FileText,
  Lock,
  Package,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useListNabuflowBillingNotifications,
  useListNabuflowPlans,
} from "@workspace/api-client-react";
import { useClerkUser } from "@/lib/clerk-safe";
import {
  formatResetDate,
  formatUsdCents,
  nabuflowComboUnlockPlan,
  nabuflowDeepUnlockPlan,
} from "@/lib/nabuflow-billing";
import { NabuflowBlockedCard } from "@/components/billing/nabuflow-blocked-card";
import {
  cardIsExpired,
  getDisabledSpendWarnings,
  MeterBar,
  SectionCard,
  SPEND_WARNING_THRESHOLDS,
  SubscriptionStatusBadge,
  useNabuflowState,
} from "./shared";

export function OverviewSection() {
  const { data: state, isLoading, isError, refetch, blockedReason } = useNabuflowState();
  const { data: plansData } = useListNabuflowPlans();
  const { data: notifData } = useListNabuflowBillingNotifications();
  const { user } = useClerkUser();

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="overview-loading">
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    );
  }
  if (isError || !state) {
    return (
      <SectionCard title="Couldn't load billing">
        <p className="text-sm text-muted-foreground">Something went wrong loading your billing state.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
        </Button>
      </SectionCard>
    );
  }

  const plans = plansData?.plans ?? [];
  const plan = state.plan ?? null;
  const cycle = state.cycle ?? null;
  const sub = state.subscription ?? null;
  const card = state.card ?? null;
  const cap = state.spendCap ?? null;
  const resetDate = formatResetDate(cycle?.resetsAt);
  const expired = cardIsExpired(card?.expMonth, card?.expYear);

  const upgradeTarget = plan
    ? (plans
        .filter((p) => p.available && p.priceUsd != null && (plan.priceUsd ?? 0) < p.priceUsd)
        .sort((a, b) => (a.priceUsd ?? 0) - (b.priceUsd ?? 0))[0] ?? null)
    : null;
  const deepUnlock = nabuflowDeepUnlockPlan(plans);
  const comboUnlock = nabuflowComboUnlockPlan(plans);

  // Spend warning banner (client display preference; server always records
  // its notifications). Skip 100% when the blocked card already says it.
  const spentPct = cap && cap.usdCents > 0 && cycle ? (cycle.overageUsdCents / cap.usdCents) * 100 : 0;
  const disabledWarnings = getDisabledSpendWarnings(user?.id);
  const crossedThreshold = state.enforcementEnabled && !state.exempt && plan
    ? [...SPEND_WARNING_THRESHOLDS].reverse().find((t) => spentPct >= t && !disabledWarnings.includes(t)) ?? null
    : null;
  const showSpendWarning =
    crossedThreshold != null && !(crossedThreshold >= 100 && blockedReason?.code === "spend_cap_reached");

  const notifications = (notifData?.notifications ?? []).slice(0, 5);

  return (
    <div className="space-y-4" data-testid="billing-overview">
      {!state.exempt && blockedReason && <NabuflowBlockedCard error={blockedReason} />}

      {showSpendWarning && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="spend-warning-banner"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            You've used {Math.min(Math.floor(spentPct), 100)}% of your {formatUsdCents(cap?.usdCents)} monthly
            spend cap.{" "}
            <Link href="/billing/limits" className="font-medium underline underline-offset-2">
              Review limits
            </Link>
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {/* Current plan */}
        <SectionCard className="md:col-span-2" testId="overview-plan-card">
          {plan ? (
            <div className="flex h-full flex-col justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-foreground">{plan.name}</h2>
                  <SubscriptionStatusBadge status={sub?.status} cancelAtPeriodEnd={sub?.cancelAtPeriodEnd} />
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {plan.priceUsd != null ? `$${plan.priceUsd}/month · ` : ""}
                  {plan.includedMonthlyCredits.toLocaleString()} credits per cycle
                </p>
                {sub?.currentCycleEnd && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {sub.cancelAtPeriodEnd ? "Plan ends" : "Cycle renews"} on{" "}
                    {formatResetDate(sub.currentCycleEnd)}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {upgradeTarget && (
                  <Button asChild size="sm" data-testid="overview-upgrade-btn">
                    <Link href={`/billing/plans?highlight=${upgradeTarget.id}`}>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Upgrade to {upgradeTarget.name}
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm" data-testid="overview-manage-btn">
                  <Link href="/billing/plans">Manage plan</Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-foreground">No plan yet</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick a NabuFlow plan to unlock monthly build credits and the engine-mode ladder.
                </p>
              </div>
              <Button asChild size="sm" data-testid="overview-choose-plan-btn">
                <Link href="/billing/plans">
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Choose a plan
                </Link>
              </Button>
            </div>
          )}
        </SectionCard>

        {/* Card on file */}
        <SectionCard title="Card on file" testId="overview-card-on-file">
          {card?.last4 ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                <span className="uppercase">{card.brand ?? "Card"}</span> •••• {card.last4}
              </p>
              <p className="text-xs text-muted-foreground">
                Expires {String(card.expMonth ?? "–").padStart(2, "0")}/{card.expYear ?? "–"}
                {expired && (
                  <Badge variant="destructive" className="ml-2">
                    Expired
                  </Badge>
                )}
              </p>
              <Link
                href="/billing/payment"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {expired ? "Update card" : "Manage payment"} <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">No card on file.</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/billing/payment">
                  <CreditCard className="mr-1.5 h-3.5 w-3.5" /> Add a card
                </Link>
              </Button>
            </div>
          )}
        </SectionCard>
      </div>

      {plan && cycle && (
        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard title="Credits this cycle" testId="overview-credits">
            <p className="mb-3 text-2xl font-bold tabular-nums text-foreground">
              {cycle.remainingIncludedCredits.toLocaleString()}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">credits left</span>
            </p>
            <MeterBar
              label="Included credits used"
              used={cycle.usedIncludedCredits}
              total={cycle.includedCredits}
              sublabel={resetDate ? `Resets on ${resetDate}` : null}
            />
            {cycle.rolloverCredits > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Includes {cycle.rolloverCredits.toLocaleString()} credits rolled over from last cycle.
              </p>
            )}
          </SectionCard>

          <SectionCard
            title="Spend vs cap"
            testId="overview-spend"
            action={
              <Link href="/billing/limits" className="text-xs font-medium text-primary hover:underline">
                Edit limit
              </Link>
            }
          >
            <p className="mb-3 text-2xl font-bold tabular-nums text-foreground">
              {formatUsdCents(cycle.overageUsdCents)}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">overage so far</span>
            </p>
            <MeterBar
              label="Pay-as-you-go spend"
              used={cycle.overageUsdCents}
              total={cap?.usdCents ?? 0}
              formatValue={(u, t) => `${formatUsdCents(u)} of ${formatUsdCents(t)} cap`}
              sublabel={resetDate ? `Cap resets on ${resetDate}` : null}
            />
          </SectionCard>
        </div>
      )}

      {plan && cycle && (
        <SectionCard
          title="Metered engine modes"
          description="Pro and Deep builds are metered per cycle on some plans."
          testId="overview-modes"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
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
            </div>
            <div>
              {plan.ladder.deepBuildsPerCycle == null ? (
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-foreground">Deep-reasoning builds</p>
                  <Badge variant="secondary">Unlimited</Badge>
                </div>
              ) : plan.ladder.deepBuildsPerCycle === 0 ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Lock className="h-3 w-3" /> Deep-reasoning builds
                  </p>
                  <Link
                    href={`/billing/plans${deepUnlock ? `?highlight=${deepUnlock.id}` : ""}`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    From {deepUnlock?.name ?? "a higher plan"} up
                  </Link>
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
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {plan.ladder.proDeepCombo
              ? "Pro + Deep together is included on your plan."
              : `Pro + Deep together is a ${comboUnlock?.name ?? "top-tier"} exclusive.`}
            {resetDate ? ` Counters reset on ${resetDate}.` : ""}
          </p>
        </SectionCard>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="Quick actions">
          <div className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline" size="sm" className="justify-start">
              <Link href="/billing/usage">
                <BarChart3 className="mr-1.5 h-3.5 w-3.5" /> Usage &amp; charts
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="justify-start">
              <Link href="/billing/invoices">
                <FileText className="mr-1.5 h-3.5 w-3.5" /> Invoices
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="justify-start">
              <Link href="/billing/limits">
                <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> Spending limits
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="justify-start" data-testid="legacy-packs-link">
              <Link href="/billing/legacy">
                <Package className="mr-1.5 h-3.5 w-3.5" /> Credit packs
              </Link>
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            One-time top-up credit packs and workspace plans live on the legacy billing page.
          </p>
        </SectionCard>

        <SectionCard title="Recent billing activity" testId="overview-notifications">
          {notifications.length === 0 ? (
            <p className="text-xs text-muted-foreground">No billing alerts yet.</p>
          ) : (
            <ul className="space-y-2">
              {notifications.map((n) => (
                <li key={n.id} className="flex items-start gap-2">
                  <Bell className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{n.title}</p>
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{n.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
