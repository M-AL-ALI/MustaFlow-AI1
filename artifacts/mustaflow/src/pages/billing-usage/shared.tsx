// Shared building blocks for the Billing & Usage section.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  getGetNabuflowBillingStateQueryKey,
  getGetNabuflowBillingStateUrl,
  type getNabuflowBillingState,
  useGetNabuflowBillingState,
} from "@workspace/api-client-react";
import { extractNabuflowGate } from "@/lib/nabuflow-billing";
import { billingMeterPercent } from "./presentation";
import {
  billingAccountRequest,
  createBillingAccountLifetime,
  useBillingAccount,
} from "@/lib/billing-account-lifetime";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

export function billingStateQueryKey(accountId: string | null) {
  return [...getGetNabuflowBillingStateQueryKey(), "account", accountId];
}

/** Shared within an account; a late response cannot populate another account's read model. */
export function useNabuflowState() {
  const account = useBillingAccount();
  const query = useGetNabuflowBillingState({
    query: {
      queryKey: billingStateQueryKey(account?.userId ?? null),
      enabled: !!account,
      placeholderData: () => undefined,
      queryFn: async ({ signal }) => {
        const lifetime = createBillingAccountLifetime(account, signal);
        try {
          return await billingAccountRequest<Awaited<ReturnType<typeof getNabuflowBillingState>>>(
            lifetime,
            getGetNabuflowBillingStateUrl(),
          );
        } finally {
          lifetime.dispose();
        }
      },
      staleTime: 15_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const data = account && !query.isPlaceholderData ? query.data : undefined;
  const blockedReason = data ? extractNabuflowGate(data.blockedReason) : null;
  return { ...query, data, blockedReason };
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  testId,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("rounded-2xl border border-border bg-card p-5 md:p-6", className)}
      data-testid={testId}
    >
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Horizontal usage meter with calm threshold colors. */
export function MeterBar({
  used,
  total,
  label,
  sublabel,
  formatValue,
  testId,
}: {
  used: number;
  total: number;
  label: string;
  sublabel?: string | null;
  formatValue?: (used: number, total: number) => string;
  testId?: string;
}) {
  const pct = billingMeterPercent(used, total);
  const valueText = formatValue
    ? formatValue(used, total)
    : `${used.toLocaleString()} of ${total.toLocaleString()}`;
  const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary";
  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-xs tabular-nums text-muted-foreground">{valueText}</p>
      </div>
      <div
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        aria-valuetext={valueText}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] motion-reduce:transition-none",
            tone,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {sublabel && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

export function cardIsExpired(expMonth?: number | null, expYear?: number | null): boolean {
  if (!expMonth || !expYear) return false;
  const now = new Date();
  return (
    expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)
  );
}

export function SubscriptionStatusBadge({
  status,
  cancelAtPeriodEnd,
}: {
  status: string | null | undefined;
  cancelAtPeriodEnd?: boolean;
}) {
  if (!status) return null;
  const label =
    cancelAtPeriodEnd && status === "active" ? "Cancels at period end" : status.replace(/_/g, " ");
  const variant =
    status === "active" || status === "trialing"
      ? cancelAtPeriodEnd
        ? ("secondary" as const)
        : ("default" as const)
      : status === "past_due" || status === "unpaid"
        ? ("destructive" as const)
        : ("secondary" as const);
  return (
    <Badge variant={variant} className="capitalize" data-testid="subscription-status-badge">
      {label}
    </Badge>
  );
}

// ── Spend warning guardrail preferences (client display preference only — the
// server always records threshold notifications regardless). Per-user keyed
// localStorage so shared browsers never leak another user's prefs.
export const SPEND_WARNING_THRESHOLDS = [50, 80, 100] as const;

function warnPrefsKey(userId: string): string {
  return `nabuflow_spend_warn_disabled_${userId}`;
}

export function getDisabledSpendWarnings(userId: string | null | undefined): number[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(warnPrefsKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

export function setSpendWarningEnabled(
  userId: string | null | undefined,
  threshold: number,
  enabled: boolean,
): void {
  if (!userId) return;
  try {
    const disabled = new Set(getDisabledSpendWarnings(userId));
    if (enabled) disabled.delete(threshold);
    else disabled.add(threshold);
    localStorage.setItem(warnPrefsKey(userId), JSON.stringify([...disabled]));
  } catch {
    // storage unavailable — display preference only, safe to ignore
  }
}
