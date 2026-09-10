import { describe, expect, it, vi } from "vitest";
vi.mock("./tenant-runtime", () => ({ tenantRuntimeProvider: {} }));

import { bindPreviewVersion, type PreviewVersionWitness } from "./preview-version-provenance";

const witness: PreviewVersionWitness = {
  projectId: 81,
  versionId: 100,
  sourceSha256: "a".repeat(64),
  sealedArtifactSha256: "b".repeat(64),
  runtimeIdentity: "runtime-project-81",
  manifestRevision: "manifest-v1",
};

describe("preview version provenance", () => {
  it("binds two independently read matching sealed witnesses", () => {
    expect(bindPreviewVersion(81, witness, { ...witness })).toEqual({
      state: "verified",
      basis: "accepted-sealed-runtime",
      ...witness,
    });
  });

  it.each([
    ["missing before", null, witness],
    ["missing after", witness, null],
    ["another project", { ...witness, projectId: 82 }, { ...witness, projectId: 82 }],
    ["different after project", witness, { ...witness, projectId: 82 }],
    ["new version", witness, { ...witness, versionId: 101 }],
    ["changed source", witness, { ...witness, sourceSha256: "c".repeat(64) }],
    ["changed runtime", witness, { ...witness, runtimeIdentity: "other-runtime" }],
    ["changed manifest", witness, { ...witness, manifestRevision: "manifest-v2" }],
    ["changed artifact", witness, { ...witness, sealedArtifactSha256: "c".repeat(64) }],
    ["missing identity", { ...witness, runtimeIdentity: "" }, { ...witness, runtimeIdentity: "" }],
    [
      "invalid source hash",
      { ...witness, sourceSha256: "newest" },
      { ...witness, sourceSha256: "newest" },
    ],
    [
      "invalid artifact hash",
      { ...witness, sealedArtifactSha256: "" },
      { ...witness, sealedArtifactSha256: "" },
    ],
    ["invalid version", { ...witness, versionId: 0 }, { ...witness, versionId: 0 }],
  ])("does not promote %s to verified version evidence", (_label, before, after) => {
    expect(
      bindPreviewVersion(
        81,
        before as PreviewVersionWitness | null,
        after as PreviewVersionWitness | null,
      ),
    ).toEqual({ state: "unverified", reason: "no-stable-sealed-version" });
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid project id %s", (projectId) => {
    expect(bindPreviewVersion(projectId, witness, witness).state).toBe("unverified");
  });
});
