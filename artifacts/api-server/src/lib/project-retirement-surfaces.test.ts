import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("project retirement route and serving surfaces", () => {
  it("enumerates production, staging, legacy and every project-domain route", () => {
    const retirement = source("./project-retirement.ts");
    expect(retirement).toContain("`${project.publicSlug}.${platformDomain}`");
    expect(retirement).toContain("`${project.publicSlug}-staging.${platformDomain}`");
    expect(retirement).toContain("project.customDomain");
    expect(retirement).toContain("...customHostnames");
    expect(retirement).not.toContain('eq(projectDomainsTable.verificationStatus, "verified")');
    expect(retirement).toContain("inventoryHostnameKVRoutesByProject(operation.projectId)");
    expect(retirement).toContain("...observedByHostname.keys()");
    expect(retirement).toContain("retireObservedHostnameKV(observation)");
    expect(retirement).toContain("purgeCacheForHostnames([");
    expect(retirement).toContain("if (!cachePurged)");
    expect(retirement).toContain("progress.route.hostnames = routeResults.map");
    expect(retirement).toContain('progress.route.cache = { state: "failed" }');
  });

  it("denies tombstoned projects on preview, live-preview, share and custom-domain reads", () => {
    const snapshot = source("./serveSnapshot.ts");
    const preview = source("./livePreviewProxy.ts");
    const sharing = source("../routes/sharing.ts");
    const customDomain = source("../middlewares/customDomainMiddleware.ts");
    const customDomainHandler = customDomain.slice(
      customDomain.indexOf("export async function customDomainMiddleware"),
    );

    expect(snapshot).toContain("innerJoin(projectsTable");
    expect(snapshot).toContain("isNull(projectsTable.deletedAt)");
    expect(preview).toContain("isNull(projectsTable.deletedAt)");
    expect(sharing).toContain("innerJoin(projectsTable");
    expect(sharing).toContain("isNull(projectsTable.deletedAt)");
    expect(customDomainHandler).toContain("isNull(projectsTable.deletedAt)");
    expect(customDomainHandler.indexOf("isNull(projectsTable.deletedAt)")).toBeLessThan(
      customDomainHandler.indexOf("proxyToContainer"),
    );
  });

  it("exposes a bounded admin-only exact-ID batch through the atomic retirement helper", () => {
    const routes = source("../routes/projects.ts");
    const start = routes.indexOf('"/admin/projects/retirement/batch"');
    const end = routes.indexOf('router.get("/projects/:id"', start);
    const batch = routes.slice(start, end);

    expect(batch).toContain("MAX_ADMIN_RETIREMENT_BATCH");
    expect(batch).toContain("requireAdmin");
    expect(batch).toContain("requireOwner");
    expect(batch).not.toContain("isAdminUser(req.userId)");
    expect(batch).toContain("new Set(requested).size !== requested.length");
    expect(batch).toContain("acceptProjectRetirement");
    expect(batch).toContain("isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)");
    expect(batch).not.toMatch(/projectId\s*[:=]\s*51/);
  });

  it("restores only into the declared non-serving control-plane projection", () => {
    const routes = source("../routes/projects.ts");
    const start = routes.indexOf('router.post("/projects/:id/restore"');
    const end = routes.indexOf('router.get("/projects/:id/retirement"', start);
    const restore = routes.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(restore).toContain("...RESTORED_PROJECT_CONTROL_PLANE_STATE");
    expect(restore).toContain("WHEN ${projectsTable.customDomain} IS NULL THEN 'unconfigured'");
    expect(restore).toContain("ELSE 'pending_verification'");
    expect(restore).not.toContain("enqueueProvisionProjectJob");
    expect(restore).not.toContain("enqueueProjectRetirementOperation");
  });

  it("retires the old slug before overwriting its database pointer", () => {
    const subdomain = source("../routes/subdomain.ts");
    const oldSlug = subdomain.indexOf("if (project.publicSlug && project.publicSlug !== rawSlug)");
    const kvRetirement = subdomain.indexOf("retireHostnameKV(hostname, projectId)", oldSlug);
    const routeRead = subdomain.indexOf("readProductionRoute(hostname)", kvRetirement);
    const cachePurge = subdomain.indexOf("purgeCacheForHostnames(oldHostnames)", routeRead);
    const overwrite = subdomain.indexOf(".set({ publicSlug: rawSlug", cachePurge);

    expect(oldSlug).toBeGreaterThan(-1);
    expect(kvRetirement).toBeGreaterThan(oldSlug);
    expect(routeRead).toBeGreaterThan(kvRetirement);
    expect(cachePurge).toBeGreaterThan(routeRead);
    expect(overwrite).toBeGreaterThan(cachePurge);
    expect(subdomain).toContain("responseProjectLifecycleSession(res)");
    expect(subdomain).not.toContain("withActiveProjectLifecycle(projectId");
  });

  it("uses exact hostname cache tags and keeps runtime responses non-cacheable", () => {
    const cloudflare = source("./cloudflare.ts");
    const snapshotWorker = source("../../../snapshot-worker/src/index.ts");
    const runtimeWorker = source("../../../nabuflow-runtime-worker/src/published-data-plane.ts");

    expect(cloudflare).toContain("JSON.stringify({ tags: batch })");
    expect(cloudflare).not.toContain("purge_everything");
    expect(snapshotWorker).toContain('headers.set("Cache-Tag", hostnameCacheTag(hostname))');
    expect(snapshotWorker).toContain("cache.put(cacheKey, response.clone())");
    expect(runtimeWorker).toContain('headers.set("cache-control", "private, no-store")');
  });

  it("keeps the dormant snapshot Worker production path fail closed", () => {
    const manifest = JSON.parse(source("../../../snapshot-worker/package.json")) as {
      scripts?: Record<string, string>;
    };
    const deploy = manifest.scripts?.deploy ?? "";
    const deployProduction = manifest.scripts?.["deploy:production"] ?? "";

    expect(deploy).toContain("process.exit(1)");
    expect(deploy).toContain("no live snapshot Worker exists");
    expect(deploy).not.toContain("wrangler deploy");
    expect(deployProduction).toContain("process.exit(1)");
    expect(deployProduction).toContain("no live snapshot Worker exists");
    expect(deployProduction).toContain("checked configuration contains placeholders");
    expect(deployProduction).not.toContain("wrangler deploy");
  });
});
