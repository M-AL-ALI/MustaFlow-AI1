import { describe, expect, it } from "vitest";

process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://openai-fixture.invalid";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-fixture-not-a-credential";

function syntheticStripeKey(kind: "s" | "r", mode: "test" | "live"): string {
  return [`${kind}k`, mode, "1234567890abcdefghijklmnop"].join("_");
}

describe("restricted Stripe key scanning", () => {
  it.each([
    [syntheticStripeKey("r", "test"), "Stripe test restricted key"],
    [syntheticStripeKey("r", "live"), "Stripe live restricted key"],
    [syntheticStripeKey("s", "test"), "Stripe test secret key"],
    [syntheticStripeKey("s", "live"), "Stripe live secret key"],
  ])("redacts %s without retaining matched text", async (value, category) => {
    const { scanForSecrets } = await import("./builder");
    const files = [{ path: "config.ts", mimeType: "text/typescript", content: value }];
    const result = scanForSecrets(files);
    expect(result.findings).toEqual([{ file: "config.ts", category }]);
    expect(result.files[0].content).not.toContain(value);
    expect(result.files[0].content).toContain("[REDACTED:");
  });
});
