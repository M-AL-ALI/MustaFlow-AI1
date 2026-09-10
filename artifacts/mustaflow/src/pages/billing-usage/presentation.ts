import { parseProrationPreview } from "@/lib/nabuflow-billing";

/** Display only: missing money must never look like a confirmed zero balance. */
export function formatBillingAmount(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null || !Number.isFinite(cents)) return "Unavailable";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "code",
    }).format(cents / 100);
  } catch {
    return "Unavailable";
  }
}

export function billingMeterPercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total)) return 0;
  if (total <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min((used / total) * 100, 100));
}

export function planChangeKind(
  currentPrice: number | null | undefined,
  targetPrice: number | null | undefined,
): "upgrade" | "downgrade" | "switch" {
  if (
    currentPrice == null ||
    targetPrice == null ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(targetPrice)
  )
    return "switch";
  if (targetPrice > currentPrice) return "upgrade";
  if (targetPrice < currentPrice) return "downgrade";
  return "switch";
}

/** Reject incomplete display data instead of confirming a guessed preview. */
export function reviewableProration(value: unknown, targetPlanId: string) {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.targetPlanId !== targetPlanId ||
    typeof raw.amountDueCents !== "number" ||
    !Number.isFinite(raw.amountDueCents) ||
    typeof raw.nextCycleAmountCents !== "number" ||
    !Number.isFinite(raw.nextCycleAmountCents) ||
    typeof raw.currency !== "string" ||
    !/^[a-z]{3}$/i.test(raw.currency)
  )
    return null;
  if (
    raw.lines != null &&
    (!Array.isArray(raw.lines) ||
      raw.lines.some((line: unknown) => {
        if (!line || typeof line !== "object") return true;
        const amount = (line as Record<string, unknown>).amountCents;
        return typeof amount !== "number" || !Number.isFinite(amount);
      }))
  )
    return null;
  return parseProrationPreview(value);
}

export function prorationAmountLabel(cents: number): string {
  return cents < 0 ? "Estimated credit adjustment" : "Estimated due on confirmation";
}
