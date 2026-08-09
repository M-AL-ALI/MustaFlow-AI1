import { describe, expect, it } from "vitest";
import {
  PANTRY_BUILD_INPUT_FORMAT,
  PANTRY_CLOSURE_FORMAT,
  PANTRY_SCHEMA_VERSION,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_SOURCE_FORMAT,
  canonicalPantryJson,
  sha256Hex,
  trustedBuildDependencyIntentHash,
  trustedBuildRequestHash,
  trustedBuildRequestSchema,
  trustedBuildSourceManifestHash,
  verifyTrustedBuildRequest,
  type TrustedBuildRequest,
} from "../src";

const PLATFORM = {
  runtime: "node" as const,
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux" as const,
  cpu: "x64" as const,
  libc: "glibc" as const,
  toolchainImageDigest: `sha256:${"8".repeat(64)}`,
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function fixture(): Promise<TrustedBuildRequest> {
  const sourceFiles = [
    { path: "build.mjs", mode: 0o644 as const, bytes: new TextEncoder().encode("build\n") },
    {
      path: "package.json",
      mode: 0o644 as const,
      bytes: new TextEncoder().encode('{"name":"fixture","private":true}'),
    },
  ];
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  const payload = new Uint8Array(sourceFiles.reduce((sum, file) => sum + file.bytes.length, 0));
  let offset = 0;
  const files = [];
  for (const file of sourceFiles) {
    payload.set(file.bytes, offset);
    files.push({
      path: file.path,
      mode: file.mode,
      offset,
      size: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes),
    });
    offset += file.bytes.byteLength;
  }
  const manifest = {
    format: TRUSTED_BUILD_SOURCE_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    payloadBytes: payload.byteLength,
    files,
  };
  const dependencyIntents = [{ ecosystem: "npm" as const, name: "is-number", selector: "7.0.0" }];
  const unsigned = {
    format: TRUSTED_BUILD_REQUEST_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    input: {
      format: PANTRY_BUILD_INPUT_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      buildId: `pbuild_${"a".repeat(22)}`,
      sourceArtifactSha256: await trustedBuildSourceManifestHash(manifest),
      dependencyIntentSha256: await trustedBuildDependencyIntentHash(dependencyIntents),
      lockfileSha256: "1".repeat(64),
      pantryRevisionId: "pantry-2026-08-08.1",
      pantryRevisionRootSha256: "2".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      platform: PLATFORM,
      buildCommand: ["node", "build.mjs"],
      createdAt: "2026-08-08T20:00:00.000Z",
    },
    source: { manifest, payloadBase64: toBase64(payload) },
    dependencyIntents,
    output: {
      strategy: "bundle-first" as const,
      dependencyPackaging: "bundle" as const,
      appDirectory: "dist",
      dependencyLayerMountPath: "node_modules" as const,
    },
  };
  const requestSha256 = await trustedBuildRequestHash(unsigned);
  return trustedBuildRequestSchema.parse({
    ...unsigned,
    requestId: `pbuildreq_${requestSha256}`,
  });
}

describe("trusted build contracts", () => {
  it("binds exact source bytes and dependency intent into a deterministic request", async () => {
    const request = await fixture();
    await expect(verifyTrustedBuildRequest(request)).resolves.toMatchObject({
      ok: true,
      requestSha256: request.requestId.slice("pbuildreq_".length),
    });
    expect(canonicalPantryJson(request)).toBe(canonicalPantryJson(structuredClone(request)));
  });

  it("rejects source-byte, source-hash, intent, request-id, and unknown-field tampering", async () => {
    const request = await fixture();
    const payloadTamper = structuredClone(request);
    const bytes = fromBase64(payloadTamper.source.payloadBase64);
    bytes[0] ^= 1;
    payloadTamper.source.payloadBase64 = toBase64(bytes);
    await expect(verifyTrustedBuildRequest(payloadTamper)).resolves.toEqual({
      ok: false,
      reason: "invalid_source",
    });

    const sourceHashTamper = structuredClone(request);
    sourceHashTamper.input.sourceArtifactSha256 = "4".repeat(64);
    await expect(verifyTrustedBuildRequest(sourceHashTamper)).resolves.toEqual({
      ok: false,
      reason: "invalid_source",
    });

    const intentTamper = structuredClone(request);
    intentTamper.input.dependencyIntentSha256 = "5".repeat(64);
    await expect(verifyTrustedBuildRequest(intentTamper)).resolves.toEqual({
      ok: false,
      reason: "invalid_dependency_intent",
    });

    const requestIdTamper = structuredClone(request);
    requestIdTamper.requestId = `pbuildreq_${"6".repeat(64)}`;
    await expect(verifyTrustedBuildRequest(requestIdTamper)).resolves.toEqual({
      ok: false,
      reason: "invalid_source",
    });

    expect(trustedBuildRequestSchema.safeParse({ ...request, surprise: true }).success).toBe(false);
  });

  it("rejects traversal, duplicate paths, unsorted intents, and payload-size mismatch", async () => {
    const request = await fixture();
    expect(
      trustedBuildRequestSchema.safeParse({
        ...request,
        source: {
          ...request.source,
          manifest: {
            ...request.source.manifest,
            files: request.source.manifest.files.map((file, index) =>
              index === 0 ? { ...file, path: "../escape" } : file,
            ),
          },
        },
      }).success,
    ).toBe(false);
    expect(
      trustedBuildRequestSchema.safeParse({
        ...request,
        dependencyIntents: [
          { ecosystem: "npm", name: "zod", selector: "4.0.0" },
          { ecosystem: "npm", name: "is-number", selector: "7.0.0" },
        ],
      }).success,
    ).toBe(false);
    expect(
      trustedBuildRequestSchema.safeParse({
        ...request,
        source: {
          ...request.source,
          manifest: { ...request.source.manifest, payloadBytes: 1 },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the package closure vocabulary separate from the source transport", () => {
    expect(PANTRY_CLOSURE_FORMAT).toBe("nabu-pantry-closure/v1");
    expect(TRUSTED_BUILD_SOURCE_FORMAT).toBe("nabu-trusted-build-source/v1");
  });
});
