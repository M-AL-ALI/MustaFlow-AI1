import { describe, expect, it } from "vitest";
import { resolveEnvStripePublishableKey } from "./stripeClient";

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
