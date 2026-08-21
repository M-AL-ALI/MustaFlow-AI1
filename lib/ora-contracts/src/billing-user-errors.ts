export const BILLING_USER_ERROR_FALLBACK =
  "We couldn't complete this billing request. Please try again.";

export const BILLING_CARD_DECLINED_ERROR =
  "Your card was declined. Please try a different card or contact your bank.";
export const BILLING_INSUFFICIENT_FUNDS_ERROR =
  "This card has insufficient funds. Please try a different payment method.";
export const BILLING_CARD_EXPIRED_ERROR = "This card has expired. Please use a different card.";

export const BILLING_USER_VISIBLE_MESSAGES = [
  BILLING_USER_ERROR_FALLBACK,
  BILLING_CARD_DECLINED_ERROR,
  BILLING_INSUFFICIENT_FUNDS_ERROR,
  BILLING_CARD_EXPIRED_ERROR,
] as const;

export type BillingUserVisibleMessage = (typeof BILLING_USER_VISIBLE_MESSAGES)[number];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: UnknownRecord, snakeCase: string, camelCase = snakeCase): string {
  const snakeValue = record[snakeCase];
  if (typeof snakeValue === "string") return snakeValue;
  const camelValue = record[camelCase];
  return typeof camelValue === "string" ? camelValue : "";
}

function errorRecord(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  const raw = isRecord(value.raw) ? value.raw : {};
  return { ...raw, ...value };
}

function normalizedExactMessage(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : isRecord(value) && typeof value.message === "string"
        ? value.message
        : typeof value === "string"
          ? value
          : "";
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Convert an untrusted Stripe failure into one of the fixed sentences that may
 * cross the API boundary. Unknown text is denied by default and never returned.
 */
export function billingProviderErrorMessage(value: unknown): BillingUserVisibleMessage {
  const record = errorRecord(value);
  const declineCode = stringField(record, "decline_code", "declineCode").toLowerCase();
  const code = stringField(record, "code").toLowerCase();

  if (declineCode === "insufficient_funds") return BILLING_INSUFFICIENT_FUNDS_ERROR;
  if (code === "expired_card" || declineCode === "expired_card") {
    return BILLING_CARD_EXPIRED_ERROR;
  }
  if (code === "card_declined" || declineCode === "generic_decline") {
    return BILLING_CARD_DECLINED_ERROR;
  }

  switch (normalizedExactMessage(value)) {
    case "your card was declined.":
      return BILLING_CARD_DECLINED_ERROR;
    case "your card has insufficient funds.":
      return BILLING_INSUFFICIENT_FUNDS_ERROR;
    case "your card has expired.":
      return BILLING_CARD_EXPIRED_ERROR;
    default:
      return BILLING_USER_ERROR_FALLBACK;
  }
}
