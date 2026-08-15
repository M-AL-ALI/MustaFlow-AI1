import { describe, expect, it } from "vitest";
import {
  acceptedSealedReleaseSchema,
  productionArtifactPromotionIdentity,
  promoteRuntimeLayeredArtifactRequestSchema,
  productionArtifactReleaseSchema,
} from "../src";

const sha = (value: string) => value.repeat(64);
const manifest = {
  revision: "manifest-accepted-1",
  runtime: "node",
  buildCommand: ["npm", "run", "build"],
  startCommand: ["node", "server.mjs"],
  servicePort: 8080,
  healthPath: "/healthz",
  resourceProfile: "dev" as const,
  public: false,
};

describe("production artifact identity contracts", () => {
  it("persists the complete accepted kitchen identity without bytes or credentials", () => {
    const release = acceptedSealedReleaseSchema.parse({
      format: "nabuflow.accepted-sealed-release/v1",
      state: "accepted",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceRuntimeIdentity: "nrf-source-preview-primary",
      sourceRevision: "source-revision-1",
      manifest,
      shelfRevisionId: "pantry-2026-08-14.1",
      shelfRootSha256: sha("a"),
      shelfStateRevision: 3,
      dependencyClosureSha256: sha("b"),
      buildId: `pbuild_zero_${sha("c")}`,
      buildAttestationSha256: sha("d"),
      artifactRevision: "artifact-accepted-1",
      sealedArtifactSha256: sha("e"),
      contentSha256: sha("f"),
      appArtifactSha256: sha("1"),
      layerContentSha256s: [sha("2")],
    });

    expect(release.shelfRevisionId).toBe("pantry-2026-08-14.1");
    expect(JSON.stringify(release)).not.toMatch(/credential|secret|payload|contentBase64/iu);
  });

  it("permits only same-project preview-to-production blue/green promotion", () => {
    const request = {
      sourceLocator: { projectId: 42, role: "preview" as const, slot: "primary" as const },
      targetLocator: { projectId: 42, role: "production" as const, slot: "green" as const },
      expectedDeploymentVersion: "worker-production-rehearsal-1",
      sourceSealedArtifactSha256: sha("a"),
      targetManifest: { ...manifest, revision: "production-manifest-1", public: true },
      targetArtifactRevision: "production-artifact-1",
      promotionIdentity: sha("b"),
    };
    expect(promoteRuntimeLayeredArtifactRequestSchema.safeParse(request).success).toBe(true);
    expect(
      promoteRuntimeLayeredArtifactRequestSchema.safeParse({
        ...request,
        targetLocator: { ...request.targetLocator, projectId: 43 },
      }).success,
    ).toBe(false);
    expect(
      promoteRuntimeLayeredArtifactRequestSchema.safeParse({
        ...request,
        targetManifest: { ...request.targetManifest, public: false },
      }).success,
    ).toBe(false);
  });

  it("derives one canonical identity and ignores hostname case only", async () => {
    const envelope = {
      format: "nabuflow.production-promotion-identity/v1" as const,
      projectId: 42,
      sourceVersionId: 99,
      sourceSealedArtifactSha256: sha("a"),
      targetSlot: "green" as const,
      hostname: "Canary.Apps.Mustaflow.Com",
    };
    const first = await productionArtifactPromotionIdentity(envelope);
    await expect(
      productionArtifactPromotionIdentity({
        ...envelope,
        hostname: envelope.hostname.toLowerCase(),
      }),
    ).resolves.toBe(first);
    await expect(
      productionArtifactPromotionIdentity({ ...envelope, targetSlot: "blue" }),
    ).resolves.not.toBe(first);
  });

  it("binds an active production release to one immutable promotion identity", () => {
    expect(
      productionArtifactReleaseSchema.parse({
        format: "nabuflow.production-artifact-release/v1",
        state: "active",
        promotionIdentity: sha("3"),
        sourceVersionId: 99,
        sourceSealedArtifactSha256: sha("4"),
        targetSealedArtifactSha256: sha("5"),
        targetContentSha256: sha("6"),
        targetRuntimeIdentity: "nrf-production-blue",
        targetSlot: "blue",
        targetManifest: { ...manifest, revision: "production-manifest-2", public: true },
        hostname: "canary.apps.mustaflow.com",
        promotedAt: "2026-08-14T12:00:00.000Z",
        activatedAt: "2026-08-14T12:01:00.000Z",
      }),
    ).toMatchObject({ state: "active", targetSlot: "blue" });
  });
});
