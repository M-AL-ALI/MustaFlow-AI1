import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@workspace/tenant-runtime-contracts";
import {
  RuntimeMaterializationRpcScope,
  consumeRuntimeMaterializationRpcResult,
} from "../src/runtime-backend";
import {
  RUNTIME_MATERIALIZER_SOURCE,
  parseRuntimeMaterializationRequest,
  runtimeMaterializationPayloadPath,
  sealRuntimeMaterializationManifest,
  verifyRuntimeMaterializationRequest,
  type RuntimeMaterializationManifest,
} from "../src/runtime-materialization";

async function fixture(): Promise<RuntimeMaterializationManifest> {
  const first = new TextEncoder().encode("alpha");
  const second = new Uint8Array([0, 1, 2, 255]);
  return {
    format: "nabu-runtime-materialization/v1",
    sealedArtifactSha256: "a".repeat(64),
    payloads: [
      { index: 1, contentSha256: await sha256Hex(second), size: second.byteLength },
      { index: 0, contentSha256: await sha256Hex(first), size: first.byteLength },
    ],
    files: [
      {
        path: "node_modules/demo.bin",
        mode: 0o755,
        payloadIndex: 1,
        offset: 0,
        size: second.byteLength,
        sha256: await sha256Hex(second),
      },
      {
        path: "server.mjs",
        mode: 0o644,
        payloadIndex: 0,
        offset: 0,
        size: first.byteLength,
        sha256: await sha256Hex(first),
      },
    ],
    seal: {
      format: "nabu-artifact-layers/v1",
      contentSha256: "b".repeat(64),
      sealedArtifactSha256: "a".repeat(64),
      manifestRevision: "manifest-1",
      finalMergedReleaseSha256: "c".repeat(64),
      layers: ["d".repeat(64)],
    },
  };
}

describe("aggregate runtime materialization", () => {
  it("seals a deterministic canonical manifest independent of input order", async () => {
    const manifest = await fixture();
    const first = await sealRuntimeMaterializationManifest(manifest);
    const second = await sealRuntimeMaterializationManifest({
      ...manifest,
      payloads: [...manifest.payloads].reverse(),
      files: [...manifest.files].reverse(),
    });

    expect(second).toEqual(first);
    expect(parseRuntimeMaterializationRequest(first).files.map((file) => file.path)).toEqual([
      "node_modules/demo.bin",
      "server.mjs",
    ]);
    await expect(verifyRuntimeMaterializationRequest(first)).resolves.toMatchObject({
      sealedArtifactSha256: "a".repeat(64),
    });
  });

  it("fails closed on manifest tampering, traversal, noncontiguous payloads, and unknown fields", async () => {
    const request = await sealRuntimeMaterializationManifest(await fixture());
    await expect(
      verifyRuntimeMaterializationRequest({
        ...request,
        canonicalManifest: request.canonicalManifest.replace("server.mjs", "../server.mjs"),
      }),
    ).rejects.toThrow(/path|integrity/u);

    const manifest = await fixture();
    manifest.files[0].offset = 1;
    await expect(sealRuntimeMaterializationManifest(manifest)).rejects.toThrow(
      /contiguous|exceeds its payload/u,
    );

    const decoded = JSON.parse(request.canonicalManifest) as Record<string, unknown>;
    decoded.cellSuppliedProvenance = ["e".repeat(64)];
    await expect(
      verifyRuntimeMaterializationRequest({
        canonicalManifest: JSON.stringify(decoded),
        manifestSha256: await sha256Hex(JSON.stringify(decoded)),
      }),
    ).rejects.toThrow(/unsupported fields/u);
  });

  it("derives content-addressed payload paths without accepting unsafe hashes", async () => {
    const manifest = await fixture();
    const payload = manifest.payloads.find((candidate) => candidate.index === 0)!;
    expect(runtimeMaterializationPayloadPath(manifest.sealedArtifactSha256, payload)).toBe(
      `/workspace/.nabuflow/materializations/${"a".repeat(64)}/00-${payload.contentSha256}.payload`,
    );
    expect(() => runtimeMaterializationPayloadPath("../unsafe", payload)).toThrow(
      /sealed artifact hash/u,
    );
  });

  it("always disposes the RPC result and owning scope when materialization is canceled", async () => {
    const disposeResult = vi.fn();
    const disposeSandbox = vi.fn();
    const scope = new RuntimeMaterializationRpcScope();
    scope.track({ [Symbol.dispose]: disposeSandbox });

    await expect(
      consumeRuntimeMaterializationRpcResult(
        scope,
        Promise.resolve({ [Symbol.dispose]: disposeResult }),
        () => {
          throw new Error("forced mid-commit cancellation");
        },
      ),
    ).rejects.toThrow("forced mid-commit cancellation");
    scope.close();

    expect(disposeResult).toHaveBeenCalledTimes(1);
    expect(disposeSandbox).toHaveBeenCalledTimes(1);
  });

  it("keeps the in-cell enforcement point strict and atomic", () => {
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain("payloadStat.isFile()");
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain("post-unpack file hash mismatch");
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain("path escaped release root");
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain(
      "await rename(temporaryReleaseRoot, releaseRoot)",
    );
    expect(RUNTIME_MATERIALIZER_SOURCE).not.toContain("symlink(");
  });
});
