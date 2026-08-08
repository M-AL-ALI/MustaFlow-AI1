import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
} from "@workspace/tenant-runtime-contracts";
import { ingestPantryStockRequest } from "../src/pantry-ingest";
import {
  NPM_REGISTRY_ORIGIN,
  NpmRegistryClient,
  PantryIngestError,
  verifyNpmSri,
} from "../src/pantry-registry-client";
import { inspectNpmTarball } from "../src/pantry-tar";

const PLATFORM = {
  runtime: "node" as const,
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux" as const,
  cpu: "x64" as const,
  libc: "glibc" as const,
  toolchainImageDigest: `sha256:${"8".repeat(64)}`,
};

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).slice(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeAscii(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarball(
  files: Array<{ path: string; body: string | Uint8Array; type?: string }>,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const file of files) {
    const body = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, file.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (file.type ?? "0").charCodeAt(0);
    writeAscii(header, 257, 6, "ustar\0");
    writeAscii(header, 263, 2, "00");
    const sum = header.reduce((total, byte) => total + byte, 0);
    writeAscii(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body, new Uint8Array((512 - (body.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.byteLength;
  }
  return gzipSync(bytes);
}

interface FixturePackage {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  os?: string[];
  integrityOverride?: string;
  fileCount?: number;
  invalidSignature?: boolean;
  tarFiles?: Array<{ path: string; body: string | Uint8Array; type?: string }>;
  attestations?: unknown;
}

async function registryFixture(packages: Record<string, FixturePackage>): Promise<{
  client: NpmRegistryClient;
  requests: Array<{ url: string; headers: Headers }>;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyid = "SHA256:fixture";
  const responses = new Map<string, Response>();
  responses.set(
    `${NPM_REGISTRY_ORIGIN}/-/npm/v1/keys`,
    Response.json({
      keys: [
        {
          keyid,
          key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        },
      ],
    }),
  );
  for (const [name, fixture] of Object.entries(packages)) {
    const version = fixture.version ?? "1.0.0";
    const bytes = tarball(
      fixture.tarFiles ?? [
        { path: "package/index.js", body: `export default ${JSON.stringify(name)};\n` },
      ],
    );
    const integrity =
      fixture.integrityOverride ?? `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const signature = fixture.invalidSignature
      ? Buffer.from("not-a-signature").toString("base64")
      : sign(null, Buffer.from(`${name}@${version}:${integrity}`), privateKey).toString("base64");
    const tarballUrl = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}/-/${name.split("/").at(-1)}-${version}.tgz`;
    const attestationsUrl = `${NPM_REGISTRY_ORIGIN}/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`;
    responses.set(
      `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}`,
      Response.json({
        name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name,
            version,
            dependencies: fixture.dependencies ?? {},
            optionalDependencies: fixture.optionalDependencies ?? {},
            peerDependencies: fixture.peerDependencies ?? {},
            scripts: fixture.scripts ?? {},
            os: fixture.os,
            license: "MIT",
            dist: {
              integrity,
              tarball: tarballUrl,
              fileCount: fixture.fileCount ?? fixture.tarFiles?.length ?? 1,
              unpackedSize: 100,
              signatures: [{ keyid, sig: signature }],
              ...(fixture.attestations === undefined
                ? {}
                : { attestations: { url: attestationsUrl } }),
            },
          },
        },
        time: { [version]: "2026-08-01T00:00:00.000Z" },
      }),
    );
    responses.set(tarballUrl, new Response(new Uint8Array(bytes).buffer));
    if (fixture.attestations !== undefined)
      responses.set(attestationsUrl, Response.json(fixture.attestations));
  }
  const requests: Array<{ url: string; headers: Headers }> = [];
  const client = new NpmRegistryClient(async (request) => {
    requests.push({ url: request.url, headers: new Headers(request.headers) });
    const response = responses.get(request.url);
    return response?.clone() ?? new Response("not found", { status: 404 });
  });
  return { client, requests };
}

async function stockRequest(names: string[]) {
  const identity = {
    intents: names.sort().map((name) => ({ ecosystem: "npm" as const, name, selector: "latest" })),
    platform: PLATFORM,
  };
  return pantryCatalogStockRequestSchema.parse({
    schemaVersion: 1,
    ...identity,
    requestSha256: await pantryCatalogStockRequestHash(identity),
    requestedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-08-08T01:00:00.000Z",
  });
}

describe("trusted npm Pantry ingest", () => {
  it("stocks an exact heavy multi-domain closure without a package allowlist", async () => {
    const { client, requests } = await registryFixture({
      "zero-heavy-app": {
        dependencies: {
          pg: "^1.0.0",
          stripe: "latest",
          sharp: "1.x",
          "maplibre-gl": ">=1",
          "socket.io": "~1.0.0",
        },
        scripts: { install: "node-gyp rebuild" },
      },
      pg: {},
      stripe: {},
      sharp: {},
      "maplibre-gl": {},
      "socket.io": {},
    });
    const result = await ingestPantryStockRequest(await stockRequest(["zero-heavy-app"]), client);
    expect(result.closure.ingredients.map((ingredient) => ingredient.package.name)).toEqual([
      "maplibre-gl",
      "pg",
      "sharp",
      "socket.io",
      "stripe",
      "zero-heavy-app",
    ]);
    expect(result.closure.ingredients.at(-1)?.lifecycleScripts).toBe("disabled");
    expect(result.objects.some((object) => object.kind === "lockfile")).toBe(true);
    expect(result.objects.some((object) => object.kind === "sbom")).toBe(true);
    expect(requests.every((request) => new URL(request.url).origin === NPM_REGISTRY_ORIGIN)).toBe(
      true,
    );
    expect(requests.every((request) => request.headers.get("authorization") === null)).toBe(true);
    expect(requests.every((request) => request.headers.get("cookie") === null)).toBe(true);
  });

  it("verifies normalized SHA-512 SRI and rejects a mutated tarball", async () => {
    const bytes = tarball([{ path: "package/index.js", body: "safe" }]);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await expect(verifyNpmSri(bytes, integrity)).resolves.toMatchObject({ ok: true });
    const mutated = bytes.slice();
    mutated[10] ^= 1;
    await expect(verifyNpmSri(mutated, integrity)).resolves.toMatchObject({ ok: false });
  });

  it("fails closed when SRI or the registry signature misses", async () => {
    const { client: badSri } = await registryFixture({
      "bad-sri": { integrityOverride: `sha512-${"A".repeat(86)}==` },
    });
    await expect(
      ingestPantryStockRequest(await stockRequest(["bad-sri"]), badSri),
    ).rejects.toMatchObject({
      code: "integrity_mismatch",
    });
    const { client: badSignature } = await registryFixture({
      "bad-signature": { invalidSignature: true },
    });
    await expect(
      ingestPantryStockRequest(await stockRequest(["bad-signature"]), badSignature),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("rejects archive bombs from metadata before downloading the tarball", async () => {
    const { client, requests } = await registryFixture({ "archive-bomb": { fileCount: 10_001 } });
    await expect(
      ingestPantryStockRequest(await stockRequest(["archive-bomb"]), client),
    ).rejects.toMatchObject({ code: "stocking_size_limit" });
    expect(requests.some((request) => request.url.endsWith(".tgz"))).toBe(false);
  });

  it.each([
    ["traversal", [{ path: "package/../escape", body: "no" }]],
    ["absolute", [{ path: "/package/escape", body: "no" }]],
    ["symlink", [{ path: "package/link", body: "target", type: "2" }]],
  ])("rejects unsafe archive %s entries", async (_label, files) => {
    await expect(inspectNpmTarball(tarball(files))).rejects.toMatchObject({
      code: "integrity_mismatch",
    });
  });

  it("rejects redirects away from the official registry before following them", async () => {
    const client = new NpmRegistryClient(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        }),
    );
    await expect(client.fetchPackument("redirected-package")).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("rejects published provenance that is not bound to the verified package bytes", async () => {
    const { client } = await registryFixture({
      "bad-provenance": {
        attestations: {
          attestations: [
            {
              bundle: {
                dsseEnvelope: {
                  payload: btoa(
                    JSON.stringify({
                      subject: [
                        { name: "pkg:npm/other@1.0.0", digest: { sha512: "0".repeat(128) } },
                      ],
                    }),
                  ),
                },
              },
            },
          ],
        },
      },
    });
    await expect(
      ingestPantryStockRequest(await stockRequest(["bad-provenance"]), client),
    ).rejects.toMatchObject({
      code: "provenance_rejected",
    });
  });

  it("fails closed on unsupported platforms and non-registry selectors", async () => {
    const { client } = await registryFixture({ "linux-only": { os: ["darwin"] } });
    await expect(
      ingestPantryStockRequest(await stockRequest(["linux-only"]), client),
    ).rejects.toMatchObject({
      code: "platform_unsupported",
    });
    const invalid = await stockRequest(["linux-only"]);
    invalid.intents[0].selector = "https://example.com/archive.tgz";
    await expect(ingestPantryStockRequest(invalid, client)).rejects.toMatchObject({
      code: "invalid_package_intent",
    });
  });

  it("resolves dependency cycles without hanging or duplicating ingredients", async () => {
    const { client } = await registryFixture({
      "cycle-a": { dependencies: { "cycle-b": "1.0.0" } },
      "cycle-b": { dependencies: { "cycle-a": "1.0.0" } },
    });
    const result = await ingestPantryStockRequest(await stockRequest(["cycle-a"]), client);
    expect(result.closure.ingredients.map((ingredient) => ingredient.package.name)).toEqual([
      "cycle-a",
      "cycle-b",
    ]);
  });

  it("uses typed fail-closed errors with no upstream response details", async () => {
    const client = new NpmRegistryClient(
      async () => new Response("provider detail", { status: 500 }),
    );
    await expect(client.fetchPackument("missing")).rejects.toEqual(
      expect.objectContaining<Partial<PantryIngestError>>({
        code: "upstream_unavailable",
        retryable: true,
        message: "Registry request failed",
      }),
    );
  });
});
