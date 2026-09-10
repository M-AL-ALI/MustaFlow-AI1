import { describe, expect, it } from "vitest";
import { IMAGE_FAILURE_FALLBACK, presentImageFailure } from "./image-failure-presentation";

describe("customer-facing image failures", () => {
  it.each([
    "429 You have no credits remaining. Add credits at https://platform.openai.com/settings/organization/billing/",
    "Image generation is not configured. Set OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.",
    "opaque-provider-diagnostic",
    null,
    { error: "provider-only-details" },
  ])("does not relay provider diagnostics or credentials: %j", (value) => {
    expect(presentImageFailure(value)).toBe(IMAGE_FAILURE_FALLBACK);
    expect(presentImageFailure(value)).not.toMatch(
      /platform\.openai|API_KEY|refunded|not charged/i,
    );
  });

  it("distinguishes a first-party credit rejection from a provider quota failure", () => {
    expect(presentImageFailure("Insufficient credits", { status: 402 })).toContain(
      "NabuFlow image credits",
    );
    expect(presentImageFailure("Insufficient credits")).toBe(IMAGE_FAILURE_FALLBACK);
    expect(presentImageFailure("Provider quota exhausted", { status: 429 })).toBe(
      IMAGE_FAILURE_FALLBACK,
    );
  });

  it("retains actionable first-party storage and admission states without returning arbitrary text", () => {
    expect(
      presentImageFailure("internal", { code: "asset_storage_reconciliation_required" }),
    ).toContain("still being verified");
    expect(presentImageFailure("Storage allowance unavailable")).toContain("could not be verified");
    expect(presentImageFailure("internal", { status: 401 })).toContain("session");
    expect(presentImageFailure("internal", { status: 404 })).toContain("unavailable");
    expect(presentImageFailure("internal", { status: 422 })).toContain("Review the prompt");
    expect(presentImageFailure("Monthly image limit reached", { status: 429 })).toContain(
      "monthly NabuFlow",
    );
    expect(presentImageFailure("Rate limit exceeded", { status: 429 })).toContain("Wait");
  });
});
