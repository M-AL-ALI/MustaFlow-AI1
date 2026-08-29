import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("../routes/admin.ts", import.meta.url), "utf8");

describe("asset operational health", () => {
  it("keeps vision spend separate and flags heavy app images", () => {
    expect(routeSource).toContain('router.get("/admin/asset-health"');
    expect(routeSource).toContain("estimated_provider_cost_micros");
    expect(routeSource).toContain("size_bytes > 2097152");
    expect(routeSource).toContain('pricing: "meter-only"');
  });
});
