import { Link } from "wouter";
import {
  ArrowUpRight,
  CalendarClock,
  CreditCard,
  Gauge,
  Lock,
  PauseCircle,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatResetDate,
  nabuflowPlanDisplayName,
  type NabuflowGateError,
  type NabuflowGateErrorCode,
} from "@/lib/nabuflow-billing";

type BlockCopy = {
  title: string;
  icon: React.ElementType;
  ctaLabel: (e: NabuflowGateError) => string;
  ctaHref: (e: NabuflowGateError) => string;
};

const BLOCK_COPY: Record<NabuflowGateErrorCode, BlockCopy> = {
  no_plan: {
    title: "Pick a plan to keep building",
    icon: Sparkles,
    ctaLabel: () => "Choose a plan",
    ctaHref: () => "/billing/plans",
  },
  subscription_inactive: {
    title: "Your plan isn't active",
    icon: PauseCircle,
    ctaLabel: () => "Reactivate a plan",
    ctaHref: () => "/billing/plans",
  },
  no_payment_method: {
    title: "Add a card to keep building",
    icon: CreditCard,
    ctaLabel: () => "Add a card",
    ctaHref: () => "/billing/payment",
  },
  card_expired: {
    title: "Your card on file has expired",
    icon: CreditCard,
    ctaLabel: () => "Update card",
    ctaHref: () => "/billing/payment",
  },
  billing_paused: {
    title: "Builds are paused — payment issue",
    icon: PauseCircle,
    ctaLabel: () => "Update payment method",
    ctaHref: () => "/billing/payment",
  },
  mode_not_available: {
    title: "This mode isn't on your plan yet",
    icon: Lock,
    ctaLabel: (e) => `Upgrade to ${nabuflowPlanDisplayName(e.upgradeTarget)}`,
    ctaHref: (e) => `/billing/plans${e.upgradeTarget ? `?highlight=${e.upgradeTarget}` : ""}`,
  },
  combo_not_available: {
    title: "Pro + Deep together is a Nova exclusive",
    icon: Lock,
    ctaLabel: (e) => `Upgrade to ${nabuflowPlanDisplayName(e.upgradeTarget ?? "nova")}`,
    ctaHref: (e) => `/billing/plans?highlight=${e.upgradeTarget ?? "nova"}`,
  },
  mode_limit_reached: {
    title: "You've used this cycle's metered builds",
    icon: Gauge,
    ctaLabel: (e) => `Upgrade to ${nabuflowPlanDisplayName(e.upgradeTarget)}`,
    ctaHref: (e) => `/billing/plans${e.upgradeTarget ? `?highlight=${e.upgradeTarget}` : ""}`,
  },
  org_suspended: {
    title: "Your organization's billing is suspended",
    icon: PauseCircle,
    ctaLabel: () => "Open organization billing",
    ctaHref: () => "/billing/org",
  },
  org_pool_exhausted: {
    title: "Your organization's credit pool is empty",
    icon: Gauge,
    ctaLabel: () => "Open organization billing",
    ctaHref: () => "/billing/org",
  },
  org_spend_cap_reached: {
    title: "Organization monthly spend cap reached",
    icon: Gauge,
    ctaLabel: () => "Open organization billing",
    ctaHref: () => "/billing/org",
  },
  org_seat_cap_reached: {
    title: "Your seat's monthly sub-cap is reached",
    icon: Gauge,
    ctaLabel: () => "Open organization billing",
    ctaHref: () => "/billing/org",
  },
  spend_cap_reached: {
    title: "Monthly spend cap reached",
    icon: Gauge,
    ctaLabel: () => "Adjust spending limit",
    ctaHref: () => "/billing/limits",
  },
};

/**
 * Calm, structured prompt for a build blocked by the NabuFlow billing gate.
 * Mirrors the server decision (never authorizes anything client-side) and
 * always offers a one-tap path into Billing & Usage.
 */
export function NabuflowBlockedCard({
  error,
  onDismiss,
  compact = false,
  className,
}: {
  error: NabuflowGateError;
  onDismiss?: () => void;
  compact?: boolean;
  className?: string;
}) {
  const copy = BLOCK_COPY[error.code] ?? BLOCK_COPY.no_plan;
  const Icon = copy.icon;
  const resetDate = formatResetDate(error.resetsAt);
  const showCounters =
    typeof error.remainingProBuilds === "number" || typeof error.remainingDeepBuilds === "number";

  return (
    <div
      role="status"
      data-testid="nabuflow-blocked-card"
      data-block-code={error.code}
      className={cn(
        "rounded-xl border border-primary/25 bg-primary/5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
        compact ? "px-3 py-2.5" : "px-3.5 py-3",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn("shrink-0 text-primary", compact ? "mt-0.5 h-3.5 w-3.5" : "mt-0.5 h-4 w-4")}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={cn(
              "font-semibold leading-tight text-foreground",
              compact ? "text-[11px]" : "text-[12px]",
            )}
          >
            {copy.title}
          </p>
          <p
            className={cn(
              "leading-snug text-muted-foreground",
              compact ? "text-[10px]" : "text-[11px]",
            )}
          >
            {error.message}
          </p>

          {(showCounters || resetDate) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
              {typeof error.remainingProBuilds === "number" && (
                <span className="text-[10px] font-medium text-foreground/70">
                  Pro builds left: {error.remainingProBuilds}
                </span>
              )}
              {typeof error.remainingDeepBuilds === "number" && (
                <span className="text-[10px] font-medium text-foreground/70">
                  Deep builds left: {error.remainingDeepBuilds}
                </span>
              )}
              {resetDate && (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <CalendarClock className="h-3 w-3" />
                  Resets on {resetDate}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            <Link
              href={copy.ctaHref(error)}
              data-testid="nabuflow-blocked-cta"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg bg-primary font-semibold text-primary-foreground transition-colors hover:bg-primary/90 no-underline",
                compact ? "px-2 py-1 text-[10px]" : "px-2.5 py-1.5 text-[11px]",
              )}
            >
              {copy.ctaLabel(error)}
              <ArrowUpRight className="h-3 w-3" />
            </Link>
            <Link
              href="/billing"
              className={cn(
                "inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground no-underline",
                compact ? "text-[10px]" : "text-[11px]",
              )}
            >
              Billing &amp; Usage
            </Link>
          </div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss billing notice"
            className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
