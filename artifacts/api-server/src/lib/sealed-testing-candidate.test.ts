import { describe, expect, it } from "vitest";
import {
  resolveSealedTestingCandidate,
  resolveSealedTestingHandoff,
  selectAcceptedSealedReleaseForSnapshot,
} from "./sealed-testing-candidate";

const sha = (digit: string) => digit.repeat(64);
const files = [
  { path: "src/index.ts", content: "export {};\n", mimeType: "application/typescript" },
  { path: "package.json", content: "{}\n", mimeType: "application/json" },
];
const release = {
  format: "nabuflow.accepted-sealed-release/v1",
  state: "accepted",
  acceptedAt: "2026-08-15T22:27:00.000Z",
  sourceRuntimeIdentity: "nrf-preview-51",
  sourceRevision: "source-v1",
  manifest: {
    revision: "manifest-v1",
    runtime: "node-api",
    buildCommand: ["npm", "run", "build"],
    startCommand: ["node", "src/index.js"],
    servicePort: 8080,
    healthPath: "/healthz",
    resourceProfile: "dev",
    public: false,
  },
  shelfRevisionId: "pantry-2026-08-15.1",
  shelfRootSha256: sha("1"),
  shelfStateRevision: 1,
  dependencyClosureSha256: sha("2"),
  buildId: `pbuild_${"a".repeat(32)}`,
  buildAttestationSha256: sha("3"),
  artifactRevision: "artifact-v1",
  sealedArtifactSha256: sha("4"),
  contentSha256: sha("5"),
  appArtifactSha256: sha("6"),
  layerContentSha256s: [sha("7")],
  declaredCapabilities: ["database"],
};
const runtime = {
  identity: "nrf-preview-51",
  manifestRevision: "manifest-v1",
  status: "running",
};

describe("sealed testing candidate", () => {
  it("accepts only the exact healthy runtime and immutable source snapshot", () => {
    expect(
      resolveSealedTestingCandidate({
        versionId: 147,
        versionSnapshot: [...files].reverse(),
        currentFiles: files,
        sealedRelease: release,
        runtime,
      }),
    ).toEqual({ versionId: 147, release });
  });

  it.each([
    ["sealed_test_release_invalid", { sealedRelease: null }],
    [
      "sealed_test_source_changed",
      { currentFiles: [{ ...files[0], content: "export const changed = true;\n" }, files[1]] },
    ],
    ["sealed_test_runtime_not_ready", { runtime: { ...runtime, status: "stopped" } }],
    ["sealed_test_runtime_mismatch", { runtime: { ...runtime, manifestRevision: "other" } }],
  ])("fails closed with typed %s", (code, override) => {
    expect(() =>
      resolveSealedTestingCandidate({
        versionId: 147,
        versionSnapshot: files,
        currentFiles: files,
        sealedRelease: release,
        runtime,
        ...override,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("selects the newest exact snapshot match instead of the newest version", () => {
    const changedFiles = [{ ...files[0], content: "export const newer = true;\n" }, files[1]];
    expect(
      selectAcceptedSealedReleaseForSnapshot({
        targetSnapshot: files,
        candidates: [
          { id: 158, filesSnapshot: changedFiles, sealedRelease: release },
          { id: 156, filesSnapshot: files, sealedRelease: release },
        ],
      }),
    ).toEqual({ sourceVersionId: 156, release });
  });

  it("binds a legacy staging snapshot to the exact accepted artifact it will promote", () => {
    const handoff = resolveSealedTestingHandoff({
      targetVersion: { id: 157, filesSnapshot: files, sealedRelease: null },
      candidates: [{ id: 156, filesSnapshot: files, sealedRelease: release }],
      currentFiles: files,
      runtime,
    });
    expect(handoff).toEqual({
      versionId: 157,
      sourceVersionId: 156,
      release,
    });
    expect(handoff.release.sealedArtifactSha256).toBe(release.sealedArtifactSha256);
  });

  it("never binds a lookalike staging snapshot with divergent bytes", () => {
    expect(() =>
      resolveSealedTestingHandoff({
        targetVersion: {
          id: 157,
          filesSnapshot: [{ ...files[0], content: "export const lookalike = true;\n" }, files[1]],
          sealedRelease: null,
        },
        candidates: [{ id: 156, filesSnapshot: files, sealedRelease: release }],
        currentFiles: files,
        runtime,
      }),
    ).toThrowError(expect.objectContaining({ code: "sealed_test_release_invalid" }));
  });
});
