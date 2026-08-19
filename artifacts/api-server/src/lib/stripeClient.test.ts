import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateStripeCredentialCache,
  resolveEnvStripePublishableKey,
  stripeAvailableSingleFlight,
} from "./stripeClient";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  invalidateStripeCredentialCache();
});

describe("Stripe env-only configuration", () => {
  it("prefers the canonical publishable-key variable", () => {
    expect(
      resolveEnvStripePublishableKey({
        STRIPE_PUBLISHABLE_KEY: "pk_test_canonical",
        STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_alias",
      }),
    ).toBe("pk_test_canonical");
  });

  it("accepts the staging test-key alias when no connector is attached", () => {
    expect(
      resolveEnvStripePublishableKey({
        STRIPE_PUBLISHABLE_KEY: "",
        STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_alias",
      }),
    ).toBe("pk_test_alias");
  });

  it("accepts the legacy Vite alias without exposing the secret key", () => {
    expect(resolveEnvStripePublishableKey({ VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_vite" })).toBe(
      "pk_test_vite",
    );
  });
});

describe("Stripe public availability single-flight", () => {
  it("coalesces concurrent cold connector reads without exposing credential material", async () => {
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connector.invalid");
    vi.stubEnv("REPL_IDENTITY", "test-identity");
    vi.stubEnv("STRIPE_SECRET_KEY", "");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          items: [{ settings: { publishable: "public-test-value", secret: "private-test-value" } }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = stripeAvailableSingleFlight();
    const second = stripeAvailableSingleFlight();
    expect(fetchMock).toHaveBeenCalledOnce();

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
