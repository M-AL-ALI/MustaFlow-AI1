import { describe, expect, it } from "vitest";
import { resolveSealedTestingCandidate } from "./sealed-testing-candidate";

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
});
