import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("project retirement domain safety surfaces", () => {
  it("protects only the active union of legacy and multi-domain hostname ids", () => {
    const source = readFileSync(new URL("./cf-scheduler.ts", import.meta.url), "utf8");
    const sweep = source.slice(
      source.indexOf("export async function runDanglingCnameSweep"),
      source.indexOf("export async function runExpiryAlert"),
    );

    expect(sweep).toContain("isNull(projectsTable.deletedAt)");
    expect(sweep).toContain("projectsTable.cfHostnameId");
    expect(sweep).toContain("buildActiveCfHostnameIdUnion");
  });

  it("strictly cleans a purchased domain before deleting either assignment pointer", () => {
    const source = readFileSync(new URL("../routes/purchased-domains.ts", import.meta.url), "utf8");
    const start = source.indexOf('router.patch("/domains/purchased/:id/project"');
    const end = source.indexOf("// GET /api/domains/purchased/:id/info", start);
    const route = source.slice(start, end);
    const security = route.indexOf("await retireCloudflareSecurityResources");
    const certificate = route.indexOf("await retireCustomHostname", security);
    const hostname = route.indexOf("await retireHostnameKV", certificate);
    const cache = route.indexOf("await purgeCacheForHostnames", hostname);
    const rowDelete = route.indexOf(".delete(projectDomainsTable)", cache);
    const pointerClear = route.indexOf("projectId: null", rowDelete);

    expect(security).toBeGreaterThan(-1);
    expect(certificate).toBeGreaterThan(security);
    expect(hostname).toBeGreaterThan(certificate);
    expect(cache).toBeGreaterThan(hostname);
    expect(rowDelete).toBeGreaterThan(cache);
    expect(pointerClear).toBeGreaterThan(rowDelete);
    expect(route.slice(cache, pointerClear)).toContain("db.transaction(async (tx)");
  });

  it("awaits default WAF creation and persists exact provider receipts", () => {
    const ssl = readFileSync(new URL("../routes/ssl.ts", import.meta.url), "utf8");
    const domains = readFileSync(new URL("../routes/domains.ts", import.meta.url), "utf8");

    expect(ssl).toContain("await ensureTrackedDefaultWaf");
    expect(ssl).not.toContain("void applyDefaultWafRules");
    expect(ssl).toContain("cloudflareResources: receipt.resources");
    const securityPatch = domains.slice(
      domains.indexOf('"/projects/:id/domains/:domainId/security"'),
      domains.indexOf("// In-memory sighting tracker", domains.indexOf("domainId/security")),
    );
    expect(securityPatch.indexOf("await retireCloudflareSecurityResources")).toBeLessThan(
      securityPatch.indexOf("await applySecurityConfig"),
    );
    expect(securityPatch).toContain("cloudflareResources: applied.resources");
  });
});
