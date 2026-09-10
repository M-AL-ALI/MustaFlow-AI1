// Billing & Usage — Plans & Upgrades. Cards render entirely from the server
// plans config (no hard-coded prices or limits); picking a plan runs the
// card-capture checkout first when needed; mid-cycle switches preview the
// exact proration before confirming.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Loader2, Lock, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  getSubscribeNabuflowPlanUrl,
  getSwitchNabuflowPlanUrl,
  getCancelNabuflowSubscriptionUrl,
  getResumeNabuflowSubscriptionUrl,
  type subscribeNabuflowPlan,
  type switchNabuflowPlan,
  type cancelNabuflowSubscription,
  type resumeNabuflowSubscription,
  useCancelNabuflowSubscription,
  useListNabuflowPlans,
  useResumeNabuflowSubscription,
  useSubscribeNabuflowPlan,
  useSwitchNabuflowPlan,
  type NabuflowPlan,
  type SubscribeNabuflowPlanBody,
} from "@workspace/api-client-react";
import {
  formatResetDate,
  nabuflowLadderLines,
  type NabuflowProrationPreview,
} from "@/lib/nabuflow-billing";
import { CardSetupDialog } from "@/components/billing/card-setup-dialog";
import { OrgSetupDialog } from "./org";
import { SectionCard, billingStateQueryKey, useNabuflowState } from "./shared";
import {
  billingAccountRequest,
  useBillingAccount,
  useBillingAccountLifetime,
  type BillingAccount,
} from "@/lib/billing-account-lifetime";
import {
  formatBillingAmount,
  planChangeKind,
  prorationAmountLabel,
  reviewableProration,
} from "./presentation";
import { SupportErrorMessage } from "@/components/support-report-link";

const ACTIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due"]);

function apiErrorMessage(err: unknown): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string") return data.error;
  return "Something went wrong. Please try again.";
}

/** "$0.012" style per-credit overage price without trailing zeros. */
function fmtPerCredit(v: number): string {
  const s = v
    .toFixed(v < 0.095 ? 3 : 2)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `$${s}`;
}

export function PlansSection() {
  const account = useBillingAccount();
  if (!account) {
    return (
      <SectionCard title="Plans are unavailable">
        <p role="status">Your account must be ready before choosing a plan.</p>
      </SectionCard>
    );
  }
  return <AccountPlansSection key={account.key} account={account} />;
}

function AccountPlansSection({ account }: { account: BillingAccount }) {
  const lifetime = useBillingAccountLifetime(account);
  const isCurrent = () => lifetime?.isCurrent() ?? false;
  const {
    data: state,
    isLoading: stateLoading,
    isError: stateError,
    isFetching: stateFetching,
    refetch: refetchState,
  } = useNabuflowState();
  const {
    data: plansData,
    isLoading,
    isError: plansError,
    isFetching: plansFetching,
    refetch: refetchPlans,
  } = useListNabuflowPlans();
  const search = useSearch();
  const highlight = useMemo(() => new URLSearchParams(search).get("highlight"), [search]);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const subscribeMutation = useSubscribeNabuflowPlan({
    request: { signal: lifetime?.signal },
    mutation: {
      mutationFn: ({ data }) =>
        billingAccountRequest<Awaited<ReturnType<typeof subscribeNabuflowPlan>>>(
          lifetime,
          getSubscribeNabuflowPlanUrl(),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          },
        ),
    },
  });
  const switchMutation = useSwitchNabuflowPlan({
    request: { signal: lifetime?.signal },
    mutation: {
      mutationFn: ({ data }) =>
        billingAccountRequest<Awaited<ReturnType<typeof switchNabuflowPlan>>>(
          lifetime,
          getSwitchNabuflowPlanUrl(),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          },
        ),
    },
  });
  const cancelMutation = useCancelNabuflowSubscription({
    request: { signal: lifetime?.signal },
    mutation: {
      mutationFn: () =>
        billingAccountRequest<Awaited<ReturnType<typeof cancelNabuflowSubscription>>>(
          lifetime,
          getCancelNabuflowSubscriptionUrl(),
          { method: "POST" },
        ),
    },
  });
  const resumeMutation = useResumeNabuflowSubscription({
    request: { signal: lifetime?.signal },
    mutation: {
      mutationFn: () =>
        billingAccountRequest<Awaited<ReturnType<typeof resumeNabuflowSubscription>>>(
          lifetime,
          getResumeNabuflowSubscriptionUrl(),
          { method: "POST" },
        ),
    },
  });

  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null);
  const [cardCaptureFor, setCardCaptureFor] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<{
    planId: string;
    planName: string;
    preview: NabuflowProrationPreview | null;
  } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [orgSetupOpen, setOrgSetupOpen] = useState(false);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const cardAttemptRef = useRef<object | null>(null);
  const previewAttemptRef = useRef<object | null>(null);
  const cancelAttemptRef = useRef<object | null>(null);
  const cardAttempt = cardAttemptRef.current;
  const previewAttempt = previewAttemptRef.current;
  const cancelAttempt = cancelAttemptRef.current;

  const plans = plansData?.plans ?? [];
  const selfServe = plans.filter((p) => p.available);
  const enterprise = plans.filter((p) => !p.available);

  const sub = state?.subscription ?? null;
  const hasActiveSub = !!sub && !!state?.plan && ACTIVE_SUB_STATUSES.has(sub.status);
  const currentPlanId = hasActiveSub ? (state?.plan?.id ?? null) : null;
  const pendingPlan = sub?.pendingPlanId
    ? (plans.find((plan) => plan.id === sub.pendingPlanId) ?? null)
    : null;
  const previewCurrentPlan = previewState?.preview
    ? plans.find((plan) => plan.id === previewState.preview?.currentPlanId)
    : null;
  const previewTargetPlan = previewState?.preview
    ? plans.find((plan) => plan.id === previewState.preview?.targetPlanId)
    : null;
  const previewKind = planChangeKind(previewCurrentPlan?.priceUsd, previewTargetPlan?.priceUsd);
  const previewIsDowngrade = previewKind === "downgrade";
  const actionPending =
    subscribeMutation.isPending ||
    switchMutation.isPending ||
    cancelMutation.isPending ||
    resumeMutation.isPending;

  useEffect(() => {
    if (highlight && highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    }
  }, [highlight, plansData]);

  const invalidate = () => {
    if (!isCurrent()) return;
    void queryClient.invalidateQueries({ queryKey: billingStateQueryKey(account.userId) });
  };

  const closePreview = () => {
    if (!isCurrent() || previewAttemptRef.current !== previewAttempt) return;
    previewAttemptRef.current = null;
    setPreviewState(null);
  };

  const doSubscribe = (planId: string, planName: string) => {
    if (!isCurrent()) return;
    setPendingPlanId(planId);
    subscribeMutation.mutate(
      { data: { planId: planId as SubscribeNabuflowPlanBody["planId"] } },
      {
        onSuccess: () => {
          if (!isCurrent()) return;
          toast({
            title: `${planName} subscription request accepted`,
            description: "Refreshing your plan details to show its current status.",
          });
          invalidate();
        },
        onError: (err) => {
          if (!isCurrent()) return;
          toast({
            title: "Couldn't start the plan",
            description: <SupportErrorMessage message={apiErrorMessage(err)} />,
            variant: "destructive",
          });
        },
        onSettled: () => {
          if (isCurrent()) setPendingPlanId(null);
        },
      },
    );
  };

  const openSwitchPreview = (plan: NabuflowPlan) => {
    if (!isCurrent()) return;
    const attempt = {};
    previewAttemptRef.current = attempt;
    setPreviewError(null);
    setPreviewState({ planId: plan.id, planName: plan.name, preview: null });
    switchMutation.mutate(
      { data: { planId: plan.id as SubscribeNabuflowPlanBody["planId"], confirm: false } },
      {
        onSuccess: (res) => {
          if (!isCurrent() || previewAttemptRef.current !== attempt) return;
          const preview = reviewableProration(res.preview, plan.id);
          if (!preview)
            setPreviewError(
              "A complete estimate was not returned. Retry before confirming a plan change.",
            );
          setPreviewState((prev) => (prev?.planId === plan.id ? { ...prev, preview } : prev));
        },
        onError: (err) => {
          if (!isCurrent() || previewAttemptRef.current !== attempt) return;
          setPreviewError(apiErrorMessage(err));
        },
      },
    );
  };

  const confirmSwitch = () => {
    if (
      !isCurrent() ||
      !previewAttempt ||
      previewAttemptRef.current !== previewAttempt ||
      !previewState?.preview ||
      previewError ||
      switchMutation.isPending
    )
      return;
    const { planId, planName } = previewState;
    switchMutation.mutate(
      { data: { planId: planId as SubscribeNabuflowPlanBody["planId"], confirm: true } },
      {
        onSuccess: (res) => {
          if (!isCurrent() || previewAttemptRef.current !== previewAttempt) return;
          const granted = res.upgradedCreditsGranted ?? 0;
          const scheduled = !!res.pendingPlanId;
          toast({
            title: scheduled ? `${planName} scheduled` : `Switched to ${planName}`,
            description: scheduled
              ? `Your current plan stays active until ${formatResetDate(res.pendingEffectiveAt) ?? "the next renewal"}.`
              : granted > 0
                ? `${granted.toLocaleString()} credits were added to this cycle right away.`
                : "The server confirmed your plan change. Refreshing plan details.",
          });
          previewAttemptRef.current = null;
          setPreviewState(null);
          invalidate();
        },
        onError: (err) => {
          if (!isCurrent() || previewAttemptRef.current !== previewAttempt) return;
          toast({
            title: "Couldn't switch plans",
            description: <SupportErrorMessage message={apiErrorMessage(err)} />,
            variant: "destructive",
          });
        },
      },
    );
  };

  const choosePlan = (plan: NabuflowPlan) => {
    if (!isCurrent() || !state || actionPending || !plan.available) return;
    if (plan.id === currentPlanId) return;
    if (hasActiveSub) {
      openSwitchPreview(plan);
      return;
    }
    if (!state?.card?.last4) {
      cardAttemptRef.current = {};
      setCardCaptureFor(plan.id);
      return;
    }
    doSubscribe(plan.id, plan.name);
  };

  const cardCapturePlan = cardCaptureFor ? plans.find((p) => p.id === cardCaptureFor) : null;

  if (isLoading || stateLoading) {
    return (
      <div
        className="grid gap-4 md:grid-cols-3"
        data-testid="plans-loading"
        role="status"
        aria-busy="true"
      >
        <span className="sr-only">Loading plans and current subscription</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-80 rounded-xl" />
        ))}
      </div>
    );
  }

  if (stateError || plansError || !state || !plansData) {
    return (
      <SectionCard title="Plans are unavailable">
        <p role="alert" className="text-sm text-muted-foreground">
          We could not load your current subscription and available plans. Retry before choosing a
          plan.
        </p>
        <Button
          className="mt-4"
          variant="outline"
          disabled={stateFetching || plansFetching}
          onClick={() => {
            if (!isCurrent()) return;
            void refetchState();
            void refetchPlans();
          }}
        >
          Retry plans
        </Button>
      </SectionCard>
    );
  }

  if (plans.length === 0) {
    return (
      <SectionCard title="No plans available">
        <p className="text-sm text-muted-foreground">
          No plans were returned. Your existing subscription has not been changed.
        </p>
        <Button
          className="mt-4"
          variant="outline"
          disabled={plansFetching}
          onClick={() => {
            if (isCurrent()) void refetchPlans();
          }}
        >
          Refresh plans
        </Button>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4" data-testid="billing-plans">
      <div className="pb-2">
        <h2 className="text-lg font-semibold tracking-tight">Choose the capacity you need</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {hasActiveSub
            ? "Review a server estimate before confirming a change. Your current plan stays selected until the server confirms the result."
            : "Prices below are monthly subscription amounts. With a saved card, Subscribe starts the selected plan; otherwise you will add a card first."}
        </p>
      </div>
      <div className="grid items-stretch gap-4 md:grid-cols-3">
        {selfServe.map((plan) => {
          const isCurrentPlan = plan.id === currentPlanId;
          const isPendingTarget = plan.id === sub?.pendingPlanId;
          const isHighlight = highlight === plan.id && !isCurrentPlan;
          const ladder = nabuflowLadderLines(plan, plans);
          const changeKind = planChangeKind(state?.plan?.priceUsd, plan.priceUsd);
          const priceHigher = changeKind === "upgrade";
          const busy =
            (subscribeMutation.isPending && pendingPlanId === plan.id) ||
            (switchMutation.isPending && previewState?.planId === plan.id);

          return (
            <div
              key={plan.id}
              ref={isHighlight ? highlightRef : undefined}
              data-testid={`plan-card-${plan.id}`}
              className={cn(
                "relative flex flex-col rounded-2xl border bg-card p-5 pt-6",
                isCurrentPlan
                  ? "border-primary/60 bg-primary/5"
                  : isHighlight
                    ? "border-primary/60 ring-2 ring-primary/30"
                    : "border-border",
              )}
            >
              {isCurrentPlan && <Badge className="absolute -top-2.5 left-4">Current plan</Badge>}
              {isHighlight && (
                <Badge variant="secondary" className="absolute -top-2.5 left-4">
                  Selected for review
                </Badge>
              )}

              {isCurrentPlan && pendingPlan && (
                <div
                  className="mb-4 mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
                  data-testid="pending-plan-note"
                >
                  Switching to {pendingPlan.name} on{" "}
                  {formatResetDate(sub?.pendingEffectiveAt) ?? "your next renewal"}. Your{" "}
                  {plan.name} plan, credits and engine access stay active until then. There is no
                  charge, refund or credit note now; upgrading before renewal cancels this change.
                </div>
              )}

              <h3 className="text-base font-bold text-foreground">{plan.name}</h3>
              <p className="mt-1.5">
                <span className="text-2xl font-bold tabular-nums text-foreground">
                  {plan.priceUsd == null ? "Price unavailable" : `$${plan.priceUsd}`}
                </span>
                <span className="text-xs text-muted-foreground">/month</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {plan.includedMonthlyCredits.toLocaleString()} credits included / cycle
              </p>

              <ul className="mt-4 flex-1 space-y-2">
                {ladder.map((line) => (
                  <li key={line.key} className="flex items-start gap-2 text-xs">
                    {line.included ? (
                      <Check className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
                    ) : (
                      <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className={line.included ? "text-foreground" : "text-muted-foreground"}>
                      {line.text}
                    </span>
                  </li>
                ))}
                <li className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  {plan.rolloverCycles > 0
                    ? `Unused included credits roll over one cycle (up to ${plan.rolloverMaxCredits.toLocaleString()})`
                    : `${plan.name} credits do not roll over`}
                </li>
                <li className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  {plan.parallelBuildLimit} parallel build{plan.parallelBuildLimit === 1 ? "" : "s"}
                </li>
                <li className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  Pay-as-you-go overage at {fmtPerCredit(plan.overageUsdPerCredit)}/credit
                </li>
              </ul>

              <div className="mt-5">
                {isCurrentPlan ? (
                  sub?.cancelAtPeriodEnd ? (
                    <div className="space-y-1.5">
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={actionPending}
                        onClick={() => {
                          if (!isCurrent()) return;
                          resumeMutation.mutate(undefined, {
                            onSuccess: () => {
                              if (!isCurrent()) return;
                              toast({
                                title: "Auto-renew resumed",
                                description:
                                  "Your plan will keep renewing and your access continues without interruption.",
                              });
                              invalidate();
                            },
                            onError: (err) => {
                              if (!isCurrent()) return;
                              toast({
                                title: "Couldn't resume",
                                description: <SupportErrorMessage message={apiErrorMessage(err)} />,
                                variant: "destructive",
                              });
                            },
                          });
                        }}
                        data-testid="plan-resume-btn"
                      >
                        {resumeMutation.isPending && (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        )}
                        Resume auto-renew
                      </Button>
                      <p className="text-center text-[11px] text-muted-foreground">
                        Currently set to end on{" "}
                        {formatResetDate(sub?.currentCycleEnd) ?? "cycle close"}. Full access
                        remains available until then.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5 text-center">
                      <Button size="sm" variant="outline" className="w-full" disabled>
                        Current plan
                      </Button>
                      <button
                        type="button"
                        className="min-h-9 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={actionPending}
                        onClick={() => {
                          if (!isCurrent()) return;
                          cancelAttemptRef.current = {};
                          setCancelError(null);
                          setConfirmCancel(true);
                        }}
                        data-testid="plan-cancel-link"
                      >
                        Cancel at period end
                      </button>
                    </div>
                  )
                ) : (
                  <Button
                    size="sm"
                    className="w-full"
                    variant={!hasActiveSub || priceHigher ? "default" : "outline"}
                    disabled={actionPending || isPendingTarget || plan.priceUsd == null}
                    aria-busy={busy}
                    onClick={() => choosePlan(plan)}
                    data-testid={`plan-cta-${plan.id}`}
                  >
                    {busy ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {isPendingTarget
                      ? `${plan.name} scheduled`
                      : hasActiveSub
                        ? `Review ${changeKind} to ${plan.name}`
                        : `Subscribe to ${plan.name}`}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {enterprise.map((plan) => (
        <div
          key={plan.id}
          className="rounded-xl border border-dashed border-border bg-card/50 p-5"
          data-testid={`plan-card-${plan.id}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
                <Building2 className="h-4 w-4 text-muted-foreground" /> {plan.name}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Enterprise plan for teams — a shared, volume-discounted credit pool, company
                invoicing with PO references, and the full engine-mode ladder for every seat.
              </p>
            </div>
            {state?.org ? (
              <Button asChild variant="outline" size="sm" data-testid="constellation-contact">
                <Link href="/billing/org">Manage organization</Link>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (isCurrent()) setOrgSetupOpen(true);
                }}
                data-testid="constellation-contact"
              >
                Contact us / Set up enterprise
              </Button>
            )}
          </div>
        </div>
      ))}

      <p className="text-[11px] text-muted-foreground">
        Every paid plan keeps a card on file. Each cycle grants the plan&apos;s included-credit
        bucket. Pro and Deep counters reset each cycle and never roll over; included credits roll
        over only where the plan card says they do.
      </p>

      {/* Proration preview dialog */}
      <Dialog
        open={!!previewState}
        onOpenChange={(open) => {
          if (!open && !switchMutation.isPending) closePreview();
        }}
      >
        <DialogContent
          className="max-h-[90dvh] max-w-lg overflow-y-auto"
          data-testid="proration-dialog"
        >
          <DialogHeader>
            <DialogTitle>Review {previewState?.planName}</DialogTitle>
            <DialogDescription>
              {!previewState?.preview
                ? "Load the server estimate to review the amount and timing before you confirm."
                : previewIsDowngrade
                  ? "This downgrade is scheduled for renewal. Your current plan continues through this billing cycle."
                  : "Review the estimated adjustment below. A plan change is only applied after confirmation succeeds."}
            </DialogDescription>
          </DialogHeader>

          {previewError ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
              <p role="alert" className="text-sm">
                <SupportErrorMessage message={previewError} />
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={switchMutation.isPending}
                onClick={() => {
                  const target = plans.find((plan) => plan.id === previewState?.planId);
                  if (target) openSwitchPreview(target);
                }}
              >
                Retry estimate
              </Button>
            </div>
          ) : previewState && !previewState.preview ? (
            <div
              role="status"
              aria-busy="true"
              className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" /> Calculating proration…
            </div>
          ) : previewState?.preview ? (
            <div className="space-y-3">
              {previewState.preview.lines.length > 0 && (
                <ul className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                  {previewState.preview.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-3 text-xs">
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {l.description ?? "Adjustment"}
                      </span>
                      <span
                        className={cn(
                          "font-medium tabular-nums",
                          l.amountCents < 0 && "text-emerald-600 dark:text-emerald-400",
                        )}
                      >
                        {formatBillingAmount(l.amountCents, previewState.preview!.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-between text-sm font-semibold text-foreground">
                <span>{prorationAmountLabel(previewState.preview.amountDueCents)}</span>
                <span className="tabular-nums" data-testid="proration-total">
                  {formatBillingAmount(
                    previewState.preview.amountDueCents,
                    previewState.preview.currency,
                  )}
                </span>
              </div>
              {previewState.preview.nextCycleAmountCents >= 0 && (
                <p className="text-xs text-muted-foreground" data-testid="next-cycle-charge">
                  Next-cycle estimate:{" "}
                  {formatBillingAmount(
                    previewState.preview.nextCycleAmountCents,
                    previewState.preview.currency,
                  )}
                  /month
                  {previewState.preview.nextCycleStartsAt
                    ? ` starting ${formatResetDate(previewState.preview.nextCycleStartsAt)}`
                    : " at the next renewal"}
                  .
                </p>
              )}
              <p className="text-[11px] leading-snug text-muted-foreground">
                {previewIsDowngrade
                  ? "Your current plan, credits and engine access continue until renewal. The new plan and price start then; upgrading before renewal cancels this pending change."
                  : previewKind === "upgrade"
                    ? "The upgrade and additional credits take effect after the server confirms the change. Unbilled usage can change the final invoice amount."
                    : "The server confirms the effective date and final amount. Review the updated plan details after confirmation."}
                {previewState.preview.periodEnd
                  ? ` Current period ends ${formatResetDate(previewState.preview.periodEnd)}.`
                  : ""}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This preview is an estimate, not a receipt. A negative adjustment is not
                confirmation of a cash refund.
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={closePreview}
              disabled={switchMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={confirmSwitch}
              disabled={!previewState?.preview || !!previewError || switchMutation.isPending}
              aria-busy={switchMutation.isPending && !!previewState?.preview}
              data-testid="proration-confirm"
            >
              {switchMutation.isPending && previewState?.preview && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {previewIsDowngrade ? "Schedule downgrade" : "Confirm switch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel confirmation */}
      <AlertDialog
        open={confirmCancel}
        onOpenChange={(open) => {
          if (!isCurrent()) return;
          setConfirmCancel(open);
          if (!open) {
            cancelAttemptRef.current = null;
            setCancelError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel your plan?</AlertDialogTitle>
            <AlertDialogDescription>
              Your plan stays active until{" "}
              {formatResetDate(sub?.currentCycleEnd) ?? "the end of the current cycle"} — credits
              and metered builds keep working until then. You can resume auto-renew any time before
              that. There are no partial-cycle refunds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancelError ? (
            <p role="alert" className="text-sm text-muted-foreground">
              <SupportErrorMessage message={cancelError} />
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep my plan</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!isCurrent() || !cancelAttempt || cancelAttemptRef.current !== cancelAttempt)
                  return;
                setCancelError(null);
                cancelMutation.mutate(undefined, {
                  onSuccess: () => {
                    if (!isCurrent() || cancelAttemptRef.current !== cancelAttempt) return;
                    cancelAttemptRef.current = null;
                    setConfirmCancel(false);
                    toast({
                      title: "Plan set to cancel",
                      description: `Full access stays active until ${formatResetDate(sub?.currentCycleEnd) ?? "cycle close"}; there is no partial-cycle refund.`,
                    });
                    invalidate();
                  },
                  onError: (err) => {
                    if (isCurrent() && cancelAttemptRef.current === cancelAttempt) {
                      setCancelError(apiErrorMessage(err));
                    }
                  },
                });
              }}
              disabled={cancelMutation.isPending}
              data-testid="plan-cancel-confirm"
            >
              {cancelMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Cancel at period end
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Card capture before first subscription */}
      <CardSetupDialog
        open={!!cardCaptureFor}
        onClose={() => {
          if (!isCurrent() || cardAttemptRef.current !== cardAttempt) return;
          cardAttemptRef.current = null;
          setCardCaptureFor(null);
        }}
        onSaved={() => {
          if (!isCurrent() || !cardAttempt || cardAttemptRef.current !== cardAttempt) return;
          cardAttemptRef.current = null;
          const planId = cardCaptureFor;
          setCardCaptureFor(null);
          invalidate();
          if (planId) {
            const p = plans.find((x) => x.id === planId);
            doSubscribe(planId, p?.name ?? planId);
          }
        }}
        title={cardCapturePlan ? `Start ${cardCapturePlan.name} — add your card` : "Add your card"}
        description="Your card is saved first, then the subscription starts on it."
        submitLabel="Save card & subscribe"
        previousLast4={state?.card?.last4 ?? null}
      />

      {/* Constellation enterprise setup (gated — no self-serve checkout) */}
      <OrgSetupDialog
        open={orgSetupOpen}
        onClose={() => {
          if (isCurrent()) setOrgSetupOpen(false);
        }}
      />
    </div>
  );
}
