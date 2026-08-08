import { describe, expect, it } from "vitest";
import {
  MAX_RUNTIME_ARTIFACT_FILE_BYTES,
  deriveRuntimeIdentity,
  verifyRuntimeArtifactEnvelope,
} from "@workspace/tenant-runtime-contracts";
import { RuntimeArtifactSealError, sealRuntimeArtifact } from "./runtime-artifact";

const targetRuntimeIdentity = await deriveRuntimeIdentity({
  namespace: "staging",
  projectId: 42,
  role: "preview",
  slot: "primary",
});

function seal(files: Parameters<typeof sealRuntimeArtifact>[0]["files"]) {
  return sealRuntimeArtifact({
    targetRuntimeIdentity,
    manifestRevision: "manifest-artifact-test-1",
    artifactRevision: "artifact-test-1",
    sourceRevision: "source-test-1",
    files,
  });
}

describe("runtime artifact sealer", () => {
  it("canonically seals text and binary files independent of input order", async () => {
    const files = [
      { path: "server.mjs", content: "console.log('ready')\n", executable: true },
      { path: "public/blob.bin", content: new Uint8Array([0, 1, 2, 255]) },
    ];
    const left = await seal(files);
    const right = await seal([...files].reverse());

    expect(left.envelope).toEqual(right.envelope);
    expect(left.envelope.content.files.map((file) => file.path)).toEqual([
      "public/blob.bin",
      "server.mjs",
    ]);
    expect(await verifyRuntimeArtifactEnvelope(left.envelope)).toBe(true);
    expect(left.chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      left.envelope.content.payloadBytes,
    );
  });

  it.each(["../escape", "/absolute", "C:/drive", "nested\\windows", "nested/.env"])(
    "rejects the unsafe path %s before producing an envelope",
    async (path) => {
      await expect(seal([{ path, content: "safe" }])).rejects.toMatchObject({
        code: "artifact_invalid_path",
      } satisfies Partial<RuntimeArtifactSealError>);
    },
  );

  it("rejects a planted fake credential before producing an envelope or chunks", async () => {
    let producedEnvelope = false;
    try {
      await seal([
        {
          path: "config.txt",
          content: "sk_test_FAKEONLYNOTAREALSECRET1234567890",
        },
      ]);
      producedEnvelope = true;
    } catch (error) {
      expect(error).toMatchObject({ code: "artifact_secret_detected" });
    }
    expect(producedEnvelope).toBe(false);
  });

  it("rejects an oversized individual file before hashing or upload", async () => {
    await expect(
      seal([
        {
          path: "oversized.bin",
          content: new Uint8Array(MAX_RUNTIME_ARTIFACT_FILE_BYTES + 1),
        },
      ]),
    ).rejects.toMatchObject({ code: "artifact_too_large" });
  });
});
