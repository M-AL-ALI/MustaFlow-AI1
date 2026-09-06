import assert from "node:assert/strict";
import {
  CloudflareRuntimeReleaseVerificationError,
  type CloudflareRuntimeCommandRunner,
  verifyCloudflareRuntimeRelease,
} from "./cloudflare-runtime-release-verifier";

const commit = "1".repeat(40);
const tree = "2".repeat(40);
const deploymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bindings = [
  ["CAPABILITY_VAULT", "durable_object_namespace"],
  ["CONTROL_COORDINATOR", "durable_object_namespace"],
  ["NABUFLOW_SANDBOX", "durable_object_namespace"],
  ["DURABLE_OPERATION_QUEUE", "queue"],
  ["NABUFLOW_RUNTIME_ARTIFACTS", "r2_bucket"],
  ["PANTRY_CATALOG", "service"],
  ["TRUSTED_BUILD_PLANE", "service"],
  ["CLOUDFLARE_CAPABILITY_VAULT_KEK_V1", "secret_text"],
  ["CLOUDFLARE_RUNTIME_CONTROL_TOKEN", "secret_text"],
  ["NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY", "secret_text"],
  ["NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED", "plain_text"],
].map(([name, type]) => ({
  name,
  type,
  ...(name === "NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED" ? { text: "enabled" } : {}),
}));

const deployment = {
  id: deploymentId,
  versions: [{ version_id: versionId, percentage: 100 }],
};
const version = {
  id: versionId,
  metadata: { created_on: "2026-09-06T15:33:52.699Z" },
  annotations: {
    "workers/message": `source-git-sha=${commit} source-git-tree=${tree}`,
    "workers/tag": `git-${commit.slice(0, 8)}`,
  },
  resources: { bindings },
};

function runnerFor(
  deploymentBody: unknown = deployment,
  versionBody: unknown = version,
  calls: string[][] = [],
): CloudflareRuntimeCommandRunner {
  return async (args) => {
    calls.push([...args]);
    return {
      code: 0,
      stdout: JSON.stringify(args[0] === "deployments" ? deploymentBody : versionBody),
      stderr: "",
    };
  };
}

const calls: string[][] = [];
const receipt = await verifyCloudflareRuntimeRelease({
  expectedCommit: commit,
  expectedTree: tree,
  configPath: "wrangler.runtime.production.jsonc",
  runner: runnerFor(deployment, version, calls),
  now: () => new Date("2026-09-06T16:00:00.000Z"),
});
assert.equal(receipt.deploymentId, deploymentId);
assert.equal(receipt.versionId, versionId);
assert.equal(receipt.expectedCommit, commit);
assert.equal(receipt.expectedTree, tree);
assert.equal(receipt.bindings.includes("NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY"), true);
assert.deepEqual(
  calls.map((args) => args.slice(0, 2)),
  [
    ["deployments", "status"],
    ["versions", "view"],
  ],
);

await assert.rejects(
  verifyCloudflareRuntimeRelease({
    expectedCommit: commit,
    expectedTree: tree,
    runner: runnerFor(deployment, {
      ...version,
      annotations: {
        ...version.annotations,
        "workers/message": `source-git-sha=${"3".repeat(40)} source-git-tree=${tree}`,
      },
    }),
  }),
  (error: unknown) =>
    error instanceof CloudflareRuntimeReleaseVerificationError &&
    error.code === "cloudflare_runtime_release_source_mismatch",
);

await assert.rejects(
  verifyCloudflareRuntimeRelease({
    expectedCommit: commit,
    expectedTree: tree,
    runner: runnerFor({
      ...deployment,
      versions: [
        { version_id: versionId, percentage: 90 },
        { version_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", percentage: 10 },
      ],
    }),
  }),
  (error: unknown) =>
    error instanceof CloudflareRuntimeReleaseVerificationError &&
    error.code === "cloudflare_runtime_release_deployment_not_exact",
);

await assert.rejects(
  verifyCloudflareRuntimeRelease({
    expectedCommit: commit,
    expectedTree: tree,
    runner: runnerFor(deployment, {
      ...version,
      resources: {
        bindings: bindings.filter(
          (binding) => binding.name !== "NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY",
        ),
      },
    }),
  }),
  (error: unknown) =>
    error instanceof CloudflareRuntimeReleaseVerificationError &&
    error.code === "cloudflare_runtime_release_bindings_unready",
);

process.stdout.write("cloudflare runtime release verifier contract: PASS (4 cases)\n");
