import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const worker = fs.readFileSync(path.join(dir, "gdpr-erasure-worker.ts"), "utf8");
const gdprRoute = fs.readFileSync(path.join(dir, "../routes/gdpr.ts"), "utf8");
const clerkRoute = fs.readFileSync(path.join(dir, "../routes/clerk-webhook.ts"), "utf8");

describe("account erasure convergence contract", () => {
  it("routes both account-deletion entry points through governed project retirement", () => {
    expect(gdprRoute).toContain("acceptOwnedProjectsForAccountErasure({");
    expect(clerkRoute).toContain("acceptOwnedProjectsForAccountErasure({");
    expect(gdprRoute).not.toContain(".update(projectsTable)");
    expect(clerkRoute).not.toContain(".update(projectsTable)");
  });

  it("does not minimize identity data when durable account erasure cannot be enqueued", () => {
    const enqueue = gdprRoute.indexOf("const jobId = await enqueueGdprErasure(userId)");
    const nullGuard = gdprRoute.indexOf("if (!jobId)", enqueue);
    const minimization = gdprRoute.indexOf("await db.transaction", nullGuard);
    const clerkDelete = gdprRoute.indexOf("deleteClerkUser(userId)", minimization);
    expect(enqueue).toBeGreaterThan(0);
    expect(nullGuard).toBeGreaterThan(enqueue);
    expect(minimization).toBeGreaterThan(nullGuard);
    expect(clerkDelete).toBeGreaterThan(minimization);
  });

  it("refuses recurring billing before retirement or identity mutation", () => {
    const paidGuard = gdprRoute.indexOf(
      "if (hasPaidAccountSubscription || hasPaidStorageSubscription)",
    );
    const retirement = gdprRoute.indexOf("acceptOwnedProjectsForAccountErasure({", paidGuard);
    const clerkDelete = gdprRoute.indexOf("deleteClerkUser(userId)", retirement);
    expect(paidGuard).toBeGreaterThan(0);
    expect(retirement).toBeGreaterThan(paidGuard);
    expect(clerkDelete).toBeGreaterThan(retirement);
  });

  it("makes Clerk retry before revoking sessions when retirement or scheduling fails", () => {
    const retirement = clerkRoute.indexOf("acceptOwnedProjectsForAccountErasure({");
    const enqueue = clerkRoute.indexOf("enqueueGdprErasure(userId)", retirement);
    const enqueueGuard = clerkRoute.indexOf("if (!erasureJobId)", enqueue);
    const revoke = clerkRoute.indexOf(".update(previewSessionsTable)", enqueueGuard);
    expect(retirement).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(retirement);
    expect(enqueueGuard).toBeGreaterThan(enqueue);
    expect(revoke).toBeGreaterThan(enqueueGuard);
  });

  it("keeps project and provider deletion out of the account-only worker", () => {
    expect(worker).toContain("gdpr_owned_projects_remain");
    expect(worker).toContain("gdpr_account_assets_remain");
    expect(worker).toContain("gdpr_active_billing_remains");
    expect(worker).not.toContain("deleteTrackedAssetStorageObjects");
    expect(worker).not.toContain("releaseProductionDatabasesForHardDelete");
    expect(worker).not.toContain("destroyContainer");
    expect(worker).not.toContain("objectStorageClient");
    expect(worker).not.toContain("db.delete(projectsTable)");
    expect(worker).not.toContain("db.delete(assetsTable)");
  });

  it("retains project assets throughout recoverable retirement", () => {
    const retirementSource = fs.readFileSync(path.join(dir, "project-retirement.ts"), "utf8");
    expect(retirementSource).toContain("deletedAt: sql`now()`");
    expect(retirementSource).not.toContain("deleteAssetObject");
    expect(retirementSource).not.toContain("delete(assetsTable)");
  });
});
