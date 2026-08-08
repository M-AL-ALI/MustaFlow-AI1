import {
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
} from "@workspace/tenant-runtime-contracts";
import { ingestPantryStockRequest } from "../src/pantry-ingest";
import { NpmRegistryClient } from "../src/pantry-registry-client";

async function main(): Promise<void> {
  const packages = process.argv.slice(2);
  const names = packages.length === 0 ? ["is-number"] : packages;
  const identity = {
    intents: names
      .map((name) => ({ ecosystem: "npm" as const, name, selector: "latest" }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    platform: {
      runtime: "node" as const,
      runtimeVersion: "22.18.0",
      nodeAbi: "127",
      os: "linux" as const,
      cpu: "x64" as const,
      libc: "glibc" as const,
      toolchainImageDigest: `sha256:${"8".repeat(64)}`,
    },
  };
  const now = Date.now();
  const request = pantryCatalogStockRequestSchema.parse({
    schemaVersion: 1,
    ...identity,
    requestSha256: await pantryCatalogStockRequestHash(identity),
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1_000).toISOString(),
  });
  const client = new NpmRegistryClient();
  let result: Awaited<ReturnType<typeof ingestPantryStockRequest>>;
  try {
    result = await ingestPantryStockRequest(request, client);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        errorType: error instanceof Error ? error.name : "UnknownError",
        lastRegistryPath: [...client.fetchCounts.keys()].at(-1)
          ? new URL([...client.fetchCounts.keys()].at(-1)!).pathname
          : null,
      })}\n`,
    );
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      roots: result.closure.roots.map((root) => `${root.name}@${root.version}`),
      ingredients: result.closure.ingredients.length,
      registrySignaturesVerified: result.closure.ingredients.every(
        (ingredient) => ingredient.provenance.registrySignatureVerified,
      ),
      provenanceStatus: result.provenanceStatus,
      objects: result.objects.length,
    })}\n`,
  );
}

void main();
