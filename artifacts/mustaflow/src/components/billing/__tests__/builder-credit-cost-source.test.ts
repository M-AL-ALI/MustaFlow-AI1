import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("builder credit cost display source of truth", () => {
  it.each(["src/pages/billing.tsx", "src/pages/settings.tsx"])(
    "%s renders the shared live credit-cost list",
    (path) => {
      const page = source(path);

      expect(page).toContain("BuilderCreditCostList");
      expect(page).not.toMatch(/cost:\s*(?:1|2|5|10)\b/);
    },
  );

  it("keeps prerendered pricing free of stale mode-cost literals", () => {
    const prerender = source("scripts/prerender.ts");

    expect(prerender).not.toContain("Lite mode = 1 credit");
    expect(prerender).not.toContain("Eco mode = 2 credits");
    expect(prerender).not.toContain("Power mode = 5 credits");
    expect(prerender).not.toContain("Pro mode = 10 credits");
    expect(prerender).toContain("Current build credit costs are shown on the live pricing page.");
  });
});
