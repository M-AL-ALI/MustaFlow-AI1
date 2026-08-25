import assert from "node:assert/strict";
import {
  ProductionReleaseVerificationError,
  verifyProductionRelease,
} from "./production-release-verifier";

const commit = "1".repeat(40);
const tree = "2".repeat(40);
const builtAt = "2026-08-26T00:00:00.000Z";

function response(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

const calls: string[] = [];
let tick = 0;
const receipt = await verifyProductionRelease({
  baseUrl: "https://www.mustaflow.com/",
  expectedTree: tree,
  now: () => new Date("2026-08-26T01:00:00.000Z"),
  monotonicNow: () => (tick += 5),
  fetchImpl: async (url) => {
    calls.push(url);
    return url.endsWith("/api/version")
      ? response(200, { commit, tree, builtAt })
      : response(200, {
          status: "ok",
          containerSubsystem: "ok",
          encryptionKey: "ok",
          startupMigrations: "ok",
          queueSchemaContract: "ok",
          buildCommit: commit,
        });
  },
});
assert.deepEqual(calls, [
  "https://www.mustaflow.com/api/version",
  "https://www.mustaflow.com/api/healthz",
]);
assert.equal(receipt.version.tree, tree);
assert.equal(receipt.health.serviceStatus, "ok");
assert.equal(receipt.version.durationMs, 5);
assert.equal(receipt.health.durationMs, 5);

await assert.rejects(
  verifyProductionRelease({
    baseUrl: "https://www.mustaflow.com",
    expectedTree: "3".repeat(40),
    fetchImpl: async () => response(200, { commit, tree, builtAt }),
  }),
  (error: unknown) =>
    error instanceof ProductionReleaseVerificationError &&
    error.code === "release_verification_tree_mismatch",
);

await assert.rejects(
  verifyProductionRelease({
    baseUrl: "https://www.mustaflow.com",
    expectedTree: tree,
    fetchImpl: async (url) =>
      url.endsWith("/api/version")
        ? response(200, { commit, tree, builtAt })
        : response(200, {
            status: "ok",
            containerSubsystem: "error",
            encryptionKey: "ok",
            startupMigrations: "ok",
            queueSchemaContract: "ok",
            buildCommit: commit,
            raw: "must never appear in an error",
          }),
  }),
  (error: unknown) => {
    assert.equal(String(error).includes("must never appear"), false);
    return (
      error instanceof ProductionReleaseVerificationError &&
      error.code === "release_verification_health_not_ready"
    );
  },
);

process.stdout.write("production release verifier contract: PASS (3 cases)\n");
