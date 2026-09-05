import { describe, expect, it } from "vitest";
import {
  acceptedSealedReleaseSchema,
  ensureProductionDatabaseRequestSchema,
  productionDatabaseAllocationIdentity,
  productionDatabaseAllocationRecordSchema,
  productionDatabaseAdmissionReceiptSchema,
  releaseProductionDatabaseRequestSchema,
} from "../src";

const sha = (value: string) => value.repeat(64);

describe("production database capability contracts", () => {
  it("binds strict admission receipts and keeps authorization distinct from sealing", () => {
    const admission = {
      format: "nabuflow.production-database-admission/v1" as const,
      issuer: "nabuflow-api" as const,
      audience: "production" as const,
      projectId: 42,
      allocationIdentity: sha("a"),
      registrationEpoch: "a18bfd98-7c06-4a3b-b0e6-617b51285683",
      birthToken: "fa259b49-d58c-41b5-bde6-18c725ae20bd",
      receiptId: "ff01ec5d-63fc-460f-a3af-04715a27e389",
      birthRegistered: true,
      assertion: "authorized" as const,
    };
    const request = {
      projectId: 42,
      expectedDeploymentVersion: "worker-admission-v1",
      allocationIdentity: admission.allocationIdentity,
    };
    expect(productionDatabaseAdmissionReceiptSchema.parse(admission)).toEqual(admission);
    expect(
      ensureProductionDatabaseRequestSchema.safeParse({ ...request, action: "ensure", admission })
        .success,
    ).toBe(true);
    expect(
      releaseProductionDatabaseRequestSchema.safeParse({ ...request, action: "release", admission })
        .success,
    ).toBe(false);
    const sealed = { ...admission, assertion: "sealed" as const };
    expect(
      releaseProductionDatabaseRequestSchema.safeParse({
        ...request,
        action: "release",
        admission: sealed,
      }).success,
    ).toBe(true);
    expect(
      ensureProductionDatabaseRequestSchema.safeParse({
        ...request,
        action: "ensure",
        admission: sealed,
      }).success,
    ).toBe(false);
    for (const invalid of [
      { ...admission, registrationEpoch: "unproven" },
      { ...admission, audience: "preview" },
      { ...admission, birthRegistered: "true" },
      { ...admission, providerProjectId: "not-a-birth-proof" },
      { ...admission, connectionString: "forbidden" },
    ]) {
      expect(productionDatabaseAdmissionReceiptSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("derives one project-owned identity independent of releases and blue/green slots", async () => {
    const envelope = {
      format: "nabuflow.production-database-allocation/v1" as const,
      deploymentNamespace: "production" as const,
      projectId: 42,
    };
    const first = await productionDatabaseAllocationIdentity(envelope);
    await expect(productionDatabaseAllocationIdentity(envelope)).resolves.toBe(first);
    await expect(
      productionDatabaseAllocationIdentity({ ...envelope, projectId: 43 }),
    ).resolves.not.toBe(first);
    expect(Object.keys(envelope)).toEqual(["format", "deploymentNamespace", "projectId"]);
  });

  it("accepts only typed opaque ensure and release requests", async () => {
    const allocationIdentity = await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: 42,
    });
    const base = { projectId: 42, expectedDeploymentVersion: "worker-1", allocationIdentity };
    expect(ensureProductionDatabaseRequestSchema.parse({ ...base, action: "ensure" })).toEqual({
      ...base,
      action: "ensure",
    });
    expect(releaseProductionDatabaseRequestSchema.parse({ ...base, action: "release" })).toEqual({
      ...base,
      action: "release",
    });
    expect(
      ensureProductionDatabaseRequestSchema.safeParse({
        ...base,
        action: "ensure",
        connectionString: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("pins ownership, region, and history retention in the vault record", () => {
    expect(
      productionDatabaseAllocationRecordSchema.parse({
        format: "nabuflow.production-database-allocation/v1",
        projectId: 42,
        allocationIdentity: sha("a"),
        provider: "neon-postgres",
        providerProjectId: "quiet-tree-123",
        providerOrganizationId: "org-production",
        regionId: "aws-us-east-2",
        historyRetentionSeconds: 604_800,
        revision: "production-database-a",
        state: "ready",
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
      }),
    ).toMatchObject({ historyRetentionSeconds: 604_800, state: "ready" });
  });

  it("keeps previously accepted releases valid and stamps new capability declarations", () => {
    const release = acceptedSealedReleaseSchema.parse({
      format: "nabuflow.accepted-sealed-release/v1",
      state: "accepted",
      acceptedAt: "2026-08-15T12:00:00.000Z",
      sourceRuntimeIdentity: "nrf-preview-primary",
      sourceRevision: "source-1",
      manifest: {
        revision: "manifest-1",
        runtime: "node",
        buildCommand: ["npm", "run", "build"],
        startCommand: ["node", "server.mjs"],
        servicePort: 8080,
        healthPath: "/healthz",
        resourceProfile: "dev",
        public: false,
      },
      shelfRevisionId: "pantry-2026-08-15.1",
      shelfRootSha256: sha("b"),
      shelfStateRevision: 1,
      dependencyClosureSha256: sha("c"),
      buildId: `pbuild_zero_${sha("d")}`,
      buildAttestationSha256: sha("e"),
      artifactRevision: "artifact-1",
      sealedArtifactSha256: sha("f"),
      contentSha256: sha("1"),
      appArtifactSha256: sha("2"),
      layerContentSha256s: [sha("3")],
    });
    expect(release.declaredCapabilities).toEqual([]);
    expect(
      acceptedSealedReleaseSchema.parse({ ...release, declaredCapabilities: ["database"] })
        .declaredCapabilities,
    ).toEqual(["database"]);
  });
});
