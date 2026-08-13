import { describe, expect, it, vi } from "vitest";
import {
  cancelStripePaymentIntent,
  createStripePaymentIntent,
  retrieveStripePaymentIntent,
  StripeBrokerError,
  type StripeFetchAdapter,
} from "../src/stripe-broker";

const syntheticStripeKey = (kind: "s" | "r", mode: "test" | "live", fill: string) =>
  [`${kind}k`, mode, fill.repeat(32)].join("_");
const TEST_KEY = syntheticStripeKey("s", "test", "a");
const RESTRICTED_TEST_KEY = syntheticStripeKey("r", "test", "r");

function paymentIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pi_test123",
    status: "requires_payment_method",
    amount: 1_099,
    amount_received: 0,
    currency: "usd",
    created: 1_785_859_200,
    livemode: false,
    client_secret: "pi_test123_secret_must-not-escape",
    ...overrides,
  };
}

describe("Stripe broker", () => {
  it("creates an unconfirmed test PaymentIntent with a fixed origin and downstream key", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.stripe.com/v1/payment_intents");
      expect(request.method).toBe("POST");
      expect(request.headers.get("stripe-version")).toBe("2025-11-17.clover");
      expect(request.headers.get("idempotency-key")).toBe(`nfg1-${"b".repeat(64)}`);
      const body = new URLSearchParams(await request.text());
      expect(body.get("amount")).toBe("1099");
      expect(body.get("currency")).toBe("usd");
      expect(body.get("confirm")).toBe("false");
      expect(body.get("automatic_payment_methods[enabled]")).toBe("true");
      expect(body.get("metadata[nabuflow_idempotency_digest]")).toBe("b".repeat(64));
      return Response.json(paymentIntent());
    });
    const result = await createStripePaymentIntent(
      TEST_KEY,
      { amount: 1_099, currency: "usd" },
      `nfg1-${"b".repeat(64)}`,
      { adapter: { fetch } },
    );
    expect(result).toEqual({
      id: "pi_test123",
      status: "requires_payment_method",
      amount: 1_099,
      amountReceived: 0,
      currency: "usd",
      created: 1_785_859_200,
      livemode: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/client.secret|s[k]_test/iu);
  });

  it("retrieves only a validated PaymentIntent path without mutation headers", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.stripe.com/v1/payment_intents/pi_test123");
      expect(request.method).toBe("GET");
      expect(request.headers.has("idempotency-key")).toBe(false);
      return Response.json(paymentIntent({ status: "processing" }));
    });
    await expect(
      retrieveStripePaymentIntent(TEST_KEY, "pi_test123", { adapter: { fetch } }),
    ).resolves.toMatchObject({ id: "pi_test123", status: "processing", livemode: false });
  });

  it("cancels a validated test PaymentIntent through the fixed API surface", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.stripe.com/v1/payment_intents/pi_test123/cancel");
      expect(request.method).toBe("POST");
      expect(request.headers.has("idempotency-key")).toBe(false);
      return Response.json(paymentIntent({ status: "canceled" }));
    });
    await expect(
      cancelStripePaymentIntent(TEST_KEY, "pi_test123", { adapter: { fetch } }),
    ).resolves.toMatchObject({ id: "pi_test123", status: "canceled", livemode: false });
  });

  it("rejects live keys and live-mode objects", async () => {
    const fetch = vi.fn(async () => Response.json(paymentIntent({ livemode: true })));
    await expect(
      createStripePaymentIntent(
        syntheticStripeKey("s", "live", "a"),
        { amount: 1_099, currency: "usd" },
        "nfg1-live-key-rejected",
        { adapter: { fetch } },
      ),
    ).rejects.toMatchObject({ code: "stripe_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      createStripePaymentIntent(
        syntheticStripeKey("r", "live", "a"),
        { amount: 1_099, currency: "usd" },
        "nfg1-restricted-live-key-rejected",
        { adapter: { fetch } },
      ),
    ).rejects.toMatchObject({ code: "stripe_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      createStripePaymentIntent(
        TEST_KEY,
        { amount: 1_099, currency: "usd" },
        "nfg1-live-object-rejected",
        { adapter: { fetch } },
      ),
    ).rejects.toMatchObject({ code: "stripe_execution_failed" });
  });

  it("accepts a restricted test key without changing the existing test-key flow", async () => {
    const fetch = vi.fn(async () => Response.json(paymentIntent()));
    await expect(
      createStripePaymentIntent(
        RESTRICTED_TEST_KEY,
        { amount: 1_099, currency: "usd" },
        "nfg1-restricted-test-key",
        { adapter: { fetch } },
      ),
    ).resolves.toMatchObject({ id: "pi_test123", livemode: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("translates provider failures without retaining raw details", async () => {
    const sensitive = `${TEST_KEY} request_log_url=https://dashboard.stripe.test/log`;
    const adapter: StripeFetchAdapter = {
      fetch: vi.fn(async () =>
        Response.json(
          { error: { message: sensitive, code: "secret-provider-code" } },
          { status: 400 },
        ),
      ),
    };
    let caught: unknown;
    try {
      await createStripePaymentIntent(
        TEST_KEY,
        { amount: 1_099, currency: "usd" },
        "nfg1-sanitized-provider-error",
        { adapter },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StripeBrokerError);
    expect(caught).toMatchObject({ status: 400, code: "stripe_invalid_request", retryable: false });
    expect(JSON.stringify(caught)).not.toContain(sensitive);
    expect(JSON.stringify(caught)).not.toContain("secret-provider-code");
  });

  it("classifies rate limits, provider outages, and timeouts", async () => {
    await expect(
      createStripePaymentIntent(TEST_KEY, { amount: 1_099, currency: "usd" }, "nfg1-rate", {
        adapter: { fetch: vi.fn(async () => Response.json({}, { status: 429 })) },
      }),
    ).rejects.toMatchObject({ code: "stripe_rate_limited", retryable: true });
    await expect(
      createStripePaymentIntent(TEST_KEY, { amount: 1_099, currency: "usd" }, "nfg1-outage", {
        adapter: { fetch: vi.fn(async () => Response.json({}, { status: 503 })) },
      }),
    ).rejects.toMatchObject({ code: "stripe_unavailable", retryable: true });

    const waitsForAbort: StripeFetchAdapter = {
      fetch: vi.fn(
        async (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    };
    await expect(
      createStripePaymentIntent(TEST_KEY, { amount: 1_099, currency: "usd" }, "nfg1-timeout", {
        adapter: waitsForAbort,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "stripe_timeout", retryable: true });
  });
});
