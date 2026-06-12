import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(resolve(here, "../ora-routing-diagnostics-panel.tsx"), "utf8");
const adminSource = readFileSync(resolve(here, "../../../pages/admin.tsx"), "utf8");

describe("Ora routing diagnostics admin panel wiring", () => {
  it("posts diagnostics through the admin auth fetch path", () => {
    expect(panelSource).toContain("authFetch");
    expect(panelSource).toContain("/api/admin/ora-routing/diagnostics");
    expect(panelSource).toContain('method: "POST"');
  });

  it("exposes the routing controls needed to inspect plan-aware behavior", () => {
    expect(panelSource).toContain("subscriptionTier");
    expect(panelSource).toContain("available");
    expect(panelSource).toContain("openCircuits");
    expect(panelSource).toContain("useLiveClassifier");
    expect(panelSource).toContain("classifier");
  });

  it("renders from the main admin dashboard", () => {
    expect(adminSource).toContain("OraRoutingDiagnosticsPanel");
    expect(adminSource).toContain("@/components/admin/ora-routing-diagnostics-panel");
  });
});
