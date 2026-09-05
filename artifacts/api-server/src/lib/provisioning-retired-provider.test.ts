import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const provisioning = readFileSync(new URL("./provisioning.ts", import.meta.url), "utf8");
const runtimeFacade = readFileSync(new URL("./tenant-runtime.ts", import.meta.url), "utf8");

describe("retired runtime provisioning boundary", () => {
  it("shares manual allocation durability instead of treating an unavailable lookup as absent", () => {
    const start = provisioning.indexOf("// Step 2 - direct automatic");
    const end = provisioning.indexOf("// Strict success criteria", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const database = provisioning.slice(start, end);
    expect(database).toContain("await ensureManualNeonAllocation({");
    expect(database).toContain("mayStartNeonAllocation(observedDatabase)");
    expect(database).toContain("recordIntent:");
    expect(database).toContain("recordOwnership:");
    expect(database).toContain("IS NOT DISTINCT FROM");
    expect(database).toContain("changed.length !== 1");
    expect(database).not.toContain("findNeonProjectByName");
    expect(database).not.toContain("createNeonProject(");
    expect(database).not.toContain("fetch(");
    const connected = database.indexOf('dbStatus: "connected"');
    expect(connected).toBeGreaterThan(database.indexOf("await upsertDatabaseUrlSecret("));
    expect(database).toContain(
      "Retry checks the existing allocation without creating another database.",
    );
  });

  it("does not select or import a Fly runtime provider", () => {
    expect(runtimeFacade).not.toMatch(/fly-runtime-provider|new\s+FlyRuntimeProvider/u);
    expect(provisioning).not.toMatch(/tenantRuntimeProvider\.providerId\s*===?\s*["']fly["']/u);
    expect(provisioning).toContain("Failed to create Cloudflare runtime for this project.");
  });

  it("does not erase runtime ownership references when infrastructure is unconfigured", () => {
    const start = provisioning.indexOf("if (!containerLayerOperational");
    const end = provisioning.indexOf("// Step 1", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const unconfiguredPath = provisioning.slice(start, end);
    expect(unconfiguredPath).toContain('provisioningStatus: "idle"');
    expect(unconfiguredPath).not.toMatch(
      /(?:containerId|containerUrl|prodContainerId|testContainerId)\s*:\s*null/u,
    );
    expect(unconfiguredPath).not.toContain("destroyContainer");
    expect(unconfiguredPath).not.toContain("createContainer");
  });
  it("routes preview retries through durable receipt CAS and fences credential persistence", () => {
    const start = provisioning.indexOf("export async function provisionPreviewDb");
    const preview = provisioning.slice(start, undefined);
    expect(start).toBeGreaterThan(-1);
    expect(preview).toContain("await ensurePreviewDatabaseAllocation({");
    expect(preview).toMatch(/signal:\s*controller\.signal,\s*assertActive,\s*recordReceipt/u);
    expect(preview).toContain("eq(projectsTable.ownerId, project.ownerId)");
    expect(preview).toContain("${projectsTable.deletedAt} IS NULL");
    expect(preview).toContain("${projectsTable.previewDbAllocation} IS NOT DISTINCT FROM");
    expect(preview).toContain("if (changed.length !== 1) return false");
    expect(preview).toContain(".where(fence(material.allocation))");
    expect(preview.indexOf("await ensurePreviewDatabaseAllocation")).toBeLessThan(
      preview.indexOf("encryptionService.encrypt(material.connectionString)"),
    );
    expect(preview).not.toContain('method: "POST"');
    expect(preview).not.toContain("findNeonProjectByName");
    expect(provisioning).not.toContain("async function createNeonProject(");
    const routes = readFileSync(new URL("../routes/projects.ts", import.meta.url), "utf8");
    expect(routes).toContain("void provisionPreviewDb(projectId).catch(() => undefined)");
    expect(routes).not.toContain("Preview DB provisioning is already in progress.");
  });
});
