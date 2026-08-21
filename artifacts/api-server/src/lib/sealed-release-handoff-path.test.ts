import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productionArtifactPromotionIdentity } from "@workspace/tenant-runtime-contracts";
import { evaluatePromotionGate } from "./publish-gate";
import {
  resolveSealedTestingHandoff,
  selectAcceptedSealedReleaseForSnapshot,
} from "./sealed-testing-candidate";
import { extractRouteHandler } from "./source-ast-test-helper";

const sha = (digit: string) => digit.repeat(64);
const files = [
  {
    path: "package.json",
    content: '{"scripts":{"start":"node src/index.js"}}\n',
    mimeType: "application/json",
  },
  {
    path: "src/index.ts",
    content: "export const revision = 'r5';\n",
    mimeType: "application/typescript",
  },
];
const release = {
  format: "nabuflow.accepted-sealed-release/v1" as const,
  state: "accepted" as const,
  acceptedAt: "2026-08-16T10:00:00.000Z",
  sourceRuntimeIdentity: "nrf-preview-51",
  sourceRevision: "source-r5",
  manifest: {
    revision: "manifest-r5",
    runtime: "node-api" as const,
    buildCommand: ["npm", "run", "build"],
    startCommand: ["node", "src/index.js"],
    servicePort: 8080,
    healthPath: "/healthz",
    resourceProfile: "dev" as const,
    public: false,
  },
  shelfRevisionId: "pantry-2026-08-16.1",
  shelfRootSha256: sha("1"),
  shelfStateRevision: 1,
  dependencyClosureSha256: sha("2"),
  buildId: `pbuild_${"a".repeat(32)}`,
  buildAttestationSha256: sha("3"),
  artifactRevision: "artifact-r5",
  sealedArtifactSha256: sha("4"),
  contentSha256: sha("5"),
  appArtifactSha256: sha("6"),
  layerContentSha256s: [sha("7")],
  declaredCapabilities: ["database" as const],
};

describe("staging -> sealed test approval -> production promotion", () => {
  it("carries one artifact identity through every boundary", async () => {
    const stagedVersionId = 157;
    const stagedRelease = selectAcceptedSealedReleaseForSnapshot({
      targetSnapshot: files,
      candidates: [{ id: 156, filesSnapshot: files, sealedRelease: release }],
    });
    const testCandidate = resolveSealedTestingHandoff({
      targetVersion: {
        id: stagedVersionId,
        filesSnapshot: files,
        sealedRelease: stagedRelease.release,
      },
      candidates: [],
      currentFiles: files,
      runtime: {
        identity: release.sourceRuntimeIdentity,
        manifestRevision: release.manifest.revision,
        status: "running",
      },
    });
    const gate = evaluatePromotionGate(
      {
        testingStatus: "passed",
        testedSnapshotId: testCandidate.versionId,
        stagingPublishedSnapshotId: stagedVersionId,
      },
      { testingApprovedAt: new Date("2026-08-16T10:05:00.000Z") },
    );
    expect(gate).toEqual({ ok: true });

    const promotionIdentity = await productionArtifactPromotionIdentity({
      format: "nabuflow.production-promotion-identity/v1",
      projectId: 51,
      sourceVersionId: stagedVersionId,
      sourceSealedArtifactSha256: testCandidate.release.sealedArtifactSha256,
      targetSlot: "blue",
      hostname: "platform-canary.apps.mustaflow.com",
    });
    expect(promotionIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(testCandidate.versionId).toBe(stagedVersionId);
    expect(testCandidate.release.sealedArtifactSha256).toBe(
      stagedRelease.release.sealedArtifactSha256,
    );
  });

  it("uses the artifact-native provider for staging promotion, not the legacy KV-only path", () => {
    const source = readFileSync(new URL("../routes/publish.ts", import.meta.url), "utf8");
    const publishRoute = extractRouteHandler(source, "post", "/projects/:id/publish");
    expect(publishRoute).toContain("selectAcceptedSealedReleaseForSnapshot({");
    expect(publishRoute).toContain("sealedRelease: artifactNativeDeployment");
    expect(publishRoute).toContain("sealedReleaseSourceVersionId");
    const promotionRoute = extractRouteHandler(source, "post", "/projects/:id/promote");
    expect(promotionRoute).toContain("promoteAcceptedArtifact({");
    expect(promotionRoute).toContain("sourceVersionId: stagingVersionForPromotion.id");
    expect(promotionRoute).toContain("sealedRelease: projectVersionsTable.sealedRelease");
    expect(promotionRoute).toContain("rollbackProductionArtifactActivation");
  });

  it("resumes a stopped sealed preview from the exact accepted release before approval", () => {
    const source = readFileSync(new URL("../routes/preview-env.ts", import.meta.url), "utf8");
    const selection = source.indexOf("const selection = selectSealedTestingHandoff({");
    const resume = source.indexOf("zeroGenerationStartAcceptedSealedRelease({");
    const verification = source.indexOf("resolveSealedTestingCandidate({");
    expect(selection).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(selection);
    expect(verification).toBeGreaterThan(resume);
    expect(source).toContain("acceptedRelease: selection.release");
  });
});
