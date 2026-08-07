import {
  stripePaymentIntentSchema,
  type StripePaymentIntent,
} from "@workspace/tenant-runtime-contracts";

const STRIPE_API_ORIGIN = "https://api.stripe.com";
const STRIPE_API_VERSION = "2025-11-17.clover";
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type StripeBrokerErrorCode =
  | "stripe_invalid_request"
  | "stripe_idempotency_conflict"
  | "stripe_rate_limited"
  | "stripe_timeout"
  | "stripe_unavailable"
  | "stripe_execution_failed";

export class StripeBrokerError extends Error {
  constructor(
    readonly status: 400 | 409 | 429 | 502 | 503 | 504,
    readonly code: StripeBrokerErrorCode,
    readonly retryable: boolean,
  ) {
    super("The payment operation could not be completed");
  }
}

export interface StripeFetchAdapter {
  fetch(request: Request): Promise<Response>;
}

const defaultFetchAdapter: StripeFetchAdapter = {
  fetch: (request) => fetch(request),
};

function validateTestSecretKey(secretKey: string): void {
  if (!/^sk_test_[A-Za-z0-9]+$/u.test(secretKey)) {
    throw new StripeBrokerError(503, "stripe_unavailable", false);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new StripeBrokerError(502, "stripe_execution_failed", false);
  }
  if (response.body === null) {
    throw new StripeBrokerError(502, "stripe_execution_failed", false);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new StripeBrokerError(502, "stripe_execution_failed", false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new StripeBrokerError(502, "stripe_execution_failed", false);
  } finally {
    bytes.fill(0);
  }
}

function translateProviderStatus(status: number): StripeBrokerError {
  if (status === 400 || status === 404 || status === 422) {
    return new StripeBrokerError(400, "stripe_invalid_request", false);
  }
  if (status === 409) {
    return new StripeBrokerError(409, "stripe_idempotency_conflict", false);
  }
  if (status === 429) {
    return new StripeBrokerError(429, "stripe_rate_limited", true);
  }
  if (status === 401 || status === 403) {
    return new StripeBrokerError(503, "stripe_unavailable", false);
  }
  if (status >= 500) {
    return new StripeBrokerError(503, "stripe_unavailable", true);
  }
  return new StripeBrokerError(502, "stripe_execution_failed", false);
}

function sanitizePaymentIntent(value: unknown): StripePaymentIntent {
  if (typeof value !== "object" || value === null) {
    throw new StripeBrokerError(502, "stripe_execution_failed", false);
  }
  const source = value as Record<string, unknown>;
  const result = stripePaymentIntentSchema.safeParse({
    id: source.id,
    status: source.status,
    amount: source.amount,
    amountReceived: source.amount_received,
    currency: source.currency,
    created: source.created,
    livemode: source.livemode,
  });
  if (!result.success) {
    // This also fails closed if Stripe ever returns a live-mode object.
    throw new StripeBrokerError(502, "stripe_execution_failed", false);
  }
  return result.data;
}

async function requestStripe(
  secretKey: string,
  pathname: string,
  init: { method: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string },
  options: { adapter?: StripeFetchAdapter; timeoutMs?: number },
): Promise<StripePaymentIntent> {
  validateTestSecretKey(secretKey);
  if (
    pathname !== "/v1/payment_intents" &&
    !/^\/v1\/payment_intents\/pi_[A-Za-z0-9]+$/u.test(pathname)
  ) {
    throw new StripeBrokerError(502, "stripe_execution_failed", false);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "stripe-version": STRIPE_API_VERSION,
    });
    if (init.body !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    if (init.idempotencyKey !== undefined) {
      headers.set("idempotency-key", init.idempotencyKey);
    }
    const response = await (options.adapter ?? defaultFetchAdapter).fetch(
      new Request(`${STRIPE_API_ORIGIN}${pathname}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      // Consume only a bounded body, then discard it without parsing or logging.
      await readBoundedJson(response).catch(() => undefined);
      throw translateProviderStatus(response.status);
    }
    return sanitizePaymentIntent(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof StripeBrokerError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new StripeBrokerError(504, "stripe_timeout", true);
    }
    throw new StripeBrokerError(503, "stripe_unavailable", true);
  } finally {
    clearTimeout(timeout);
  }
}

export function createStripePaymentIntent(
  secretKey: string,
  input: { amount: number; currency: string },
  downstreamIdempotencyKey: string,
  options: { adapter?: StripeFetchAdapter; timeoutMs?: number } = {},
): Promise<StripePaymentIntent> {
  const body = new URLSearchParams({
    amount: String(input.amount),
    currency: input.currency,
    confirm: "false",
    "automatic_payment_methods[enabled]": "true",
    "metadata[nabuflow_idempotency_digest]": downstreamIdempotencyKey.replace(/^nfg1-/u, ""),
  });
  return requestStripe(
    secretKey,
    "/v1/payment_intents",
    { method: "POST", body, idempotencyKey: downstreamIdempotencyKey },
    options,
  );
}

export function retrieveStripePaymentIntent(
  secretKey: string,
  paymentIntentId: string,
  options: { adapter?: StripeFetchAdapter; timeoutMs?: number } = {},
): Promise<StripePaymentIntent> {
  return requestStripe(
    secretKey,
    `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    { method: "GET" },
    options,
  );
}
