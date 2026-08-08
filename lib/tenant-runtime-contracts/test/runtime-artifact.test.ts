import { describe, expect, it } from "vitest";
import {
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_FORMAT,
  canonicalJson,
  deriveRuntimeIdentity,
  runtimeArtifactContentHash,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactEnvelopeSchema,
  runtimeArtifactSealedHash,
  sha256Hex,
  validateRuntimeArtifactPath,
  verifyRuntimeArtifactEnvelope,
} from "../src";

describe("runtime artifact contract", () => {
  it("binds the sealed hash to the exact content, runtime identity, and manifest revision", async () => {
    const bytes = new TextEncoder().encode("hello");
    const fileSha256 = await sha256Hex(bytes);
    const content = runtimeArtifactContentManifestSchema.parse({
      format: RUNTIME_ARTIFACT_FORMAT,
      payloadBytes: bytes.byteLength,
      chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
      chunks: [fileSha256],
      files: [
        { path: "server.mjs", mode: 0o644, offset: 0, size: bytes.byteLength, sha256: fileSha256 },
      ],
    });
    const unsigned = {
      content,
      contentSha256: await runtimeArtifactContentHash(content),
      targetRuntimeIdentity: await deriveRuntimeIdentity({
        namespace: "staging",
        projectId: 42,
        role: "preview" as const,
        slot: "primary" as const,
      }),
      manifestRevision: "manifest-contract-1",
      artifactRevision: "artifact-contract-1",
      sourceRevision: "source-contract-1",
      scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true as const },
    };
    const envelope = runtimeArtifactEnvelopeSchema.parse({
      ...unsigned,
      sealedArtifactSha256: await runtimeArtifactSealedHash(unsigned),
    });

    expect(await verifyRuntimeArtifactEnvelope(envelope)).toBe(true);
    expect(
      await verifyRuntimeArtifactEnvelope({ ...envelope, manifestRevision: "manifest-contract-2" }),
    ).toBe(false);
    expect(
      await verifyRuntimeArtifactEnvelope({
        ...envelope,
        targetRuntimeIdentity: await deriveRuntimeIdentity({
          namespace: "staging",
          projectId: 43,
          role: "preview",
          slot: "primary",
        }),
      }),
    ).toBe(false);
  });

  it("uses deterministic recursively sorted canonical JSON", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: [2, "x"] } })).toBe(
      '{"a":{"b":[2,"x"],"y":true},"z":1}',
    );
  });

  it.each(["../escape", "/absolute", "C:/drive", "a\\b", ".nabuflow/seal"])(
    "rejects receiver-unsafe path %s",
    (path) => expect(validateRuntimeArtifactPath(path)).toBeNull(),
  );
});
