import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_COMMAND_OUTPUT_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 60_000;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_RUNTIME_CONFIG = resolve(
  REPOSITORY_ROOT,
  "artifacts/nabuflow-runtime-worker/wrangler.runtime.production.jsonc",
);

export const CLOUDFLARE_RUNTIME_RELEASE_VERIFIER_SEMANTICS =
  "nabuflow-cloudflare-runtime-release-verifier-v1" as const;

const REQUIRED_BINDINGS = [
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
  ["NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID", "plain_text"],
  ["NABUFLOW_PRODUCTION_NEON_REGION_ID", "plain_text"],
  ["NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS", "plain_text"],
  ["NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS", "plain_text"],
  ["NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH", "plain_text"],
] as const;

const REQUIRED_DATABASE_PLAIN_TEXT_BINDINGS = [
  "NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED",
  "NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID",
  "NABUFLOW_PRODUCTION_NEON_REGION_ID",
  "NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS",
  "NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS",
  "NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH",
] as const;

type CommandName = "deployments-status" | "versions-view";

export type CloudflareRuntimeCommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type CloudflareRuntimeCommandRunner = (
  args: readonly string[],
) => Promise<CloudflareRuntimeCommandResult>;

export type CloudflareRuntimeReleaseReceipt = Readonly<{
  semantics: typeof CLOUDFLARE_RUNTIME_RELEASE_VERIFIER_SEMANTICS;
  verifiedAt: string;
  expectedCommit: string;
  expectedTree: string;
  deploymentId: string;
  versionId: string;
  createdOn: string;
  sourceMessage: string;
  sourceTag: string;
  bindings: readonly string[];
}>;

export class CloudflareRuntimeReleaseVerificationError extends Error {
  readonly name = "CloudflareRuntimeReleaseVerificationError";

  constructor(
    readonly code:
      | "cloudflare_runtime_release_input_invalid"
      | "cloudflare_runtime_release_command_failed"
      | "cloudflare_runtime_release_response_too_large"
      | "cloudflare_runtime_release_response_invalid"
      | "cloudflare_runtime_release_deployment_not_exact"
      | "cloudflare_runtime_release_source_mismatch"
      | "cloudflare_runtime_release_bindings_unready",
    readonly command: CommandName | null,
  ) {
    super(code);
  }
}

type VerificationOptions = {
  expectedCommit: string;
  expectedTree: string;
  configPath?: string;
  timeoutMs?: number;
  runner?: CloudflareRuntimeCommandRunner;
  now?: () => Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredDatabaseBindings(configPath: string): ReadonlyMap<string, string> {
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_bindings_unready",
      "versions-view",
    );
  }
  const values = new Map<string, string>();
  for (const name of REQUIRED_DATABASE_PLAIN_TEXT_BINDINGS) {
    const match = new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`, "u").exec(source);
    if (!match?.[1]) {
      throw new CloudflareRuntimeReleaseVerificationError(
        "cloudflare_runtime_release_bindings_unready",
        "versions-view",
      );
    }
    values.set(name, match[1]);
  }
  const epoch = values.get("NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH");
  const organization = values.get("NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID");
  const region = values.get("NABUFLOW_PRODUCTION_NEON_REGION_ID");
  const retention = Number(values.get("NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS"));
  const maximum = Number(values.get("NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS"));
  if (
    values.get("NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED") !== "enabled" ||
    !epoch ||
    !UUID.test(epoch) ||
    !organization?.startsWith("org-") ||
    !region ||
    !Number.isSafeInteger(retention) ||
    retention <= 0 ||
    !Number.isSafeInteger(maximum) ||
    maximum <= 0
  ) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_bindings_unready",
      "versions-view",
    );
  }
  return values;
}

function commandRunner(timeoutMs: number): CloudflareRuntimeCommandRunner {
  return async (args) => {
    const pnpmEntry = process.env.npm_execpath?.trim();
    if (!pnpmEntry) {
      return { code: 127, stdout: "", stderr: "pnpm entry point unavailable" };
    }
    const nodeExecutable = process.env.npm_node_execpath?.trim() || process.execPath;
    return await new Promise<CloudflareRuntimeCommandResult>((resolvePromise) => {
      const child = spawn(
        nodeExecutable,
        [pnpmEntry, "--filter", "@workspace/nabuflow-runtime-worker", "exec", "wrangler", ...args],
        {
          cwd: REPOSITORY_ROOT,
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CloudflareRuntimeCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill();
          finish({ code: 75, stdout, stderr });
          return current;
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on("error", () => finish({ code: 127, stdout, stderr }));
      child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
      const timer = setTimeout(() => {
        child.kill();
        finish({ code: 124, stdout, stderr });
      }, timeoutMs);
    });
  };
}

function parseCommandJson(
  result: CloudflareRuntimeCommandResult,
  command: CommandName,
): Record<string, unknown> {
  if (result.code !== 0) {
    throw new CloudflareRuntimeReleaseVerificationError(
      result.code === 75
        ? "cloudflare_runtime_release_response_too_large"
        : "cloudflare_runtime_release_command_failed",
      command,
    );
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_response_too_large",
      command,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!isRecord(parsed)) throw new Error("not_object");
    return parsed;
  } catch {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_response_invalid",
      command,
    );
  }
}

function hasBinding(bindings: readonly unknown[], name: string, type: string): boolean {
  return bindings.some(
    (binding) => isRecord(binding) && binding.name === name && binding.type === type,
  );
}

export async function verifyCloudflareRuntimeRelease(
  options: VerificationOptions,
): Promise<CloudflareRuntimeReleaseReceipt> {
  if (!GIT_OBJECT_ID.test(options.expectedCommit) || !GIT_OBJECT_ID.test(options.expectedTree)) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_input_invalid",
      null,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_input_invalid",
      null,
    );
  }
  const configPath = resolve(options.configPath ?? DEFAULT_RUNTIME_CONFIG);
  const runner = options.runner ?? commandRunner(timeoutMs);
  const deployment = parseCommandJson(
    await runner(["deployments", "status", "--config", configPath, "--json"]),
    "deployments-status",
  );
  if (
    typeof deployment.id !== "string" ||
    !UUID.test(deployment.id) ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    !isRecord(deployment.versions[0]) ||
    typeof deployment.versions[0].version_id !== "string" ||
    !UUID.test(deployment.versions[0].version_id) ||
    deployment.versions[0].percentage !== 100
  ) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_deployment_not_exact",
      "deployments-status",
    );
  }
  const versionId = deployment.versions[0].version_id;
  const version = parseCommandJson(
    await runner(["versions", "view", versionId, "--config", configPath, "--json"]),
    "versions-view",
  );
  const metadata = version.metadata;
  const annotations = version.annotations;
  const resources = version.resources;
  if (
    version.id !== versionId ||
    !isRecord(metadata) ||
    typeof metadata.created_on !== "string" ||
    !Number.isFinite(Date.parse(metadata.created_on)) ||
    !isRecord(annotations) ||
    !isRecord(resources) ||
    !Array.isArray(resources.bindings)
  ) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_response_invalid",
      "versions-view",
    );
  }
  const expectedMessage = `source-git-sha=${options.expectedCommit} source-git-tree=${options.expectedTree}`;
  const expectedTag = `git-${options.expectedCommit.slice(0, 8)}`;
  if (
    annotations["workers/message"] !== expectedMessage ||
    annotations["workers/tag"] !== expectedTag
  ) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_source_mismatch",
      "versions-view",
    );
  }
  const missingBindings = REQUIRED_BINDINGS.filter(
    ([name, type]) => !hasBinding(resources.bindings as readonly unknown[], name, type),
  );
  const expectedDatabaseBindings = configuredDatabaseBindings(configPath);
  const mismatchedDatabaseBindings = REQUIRED_DATABASE_PLAIN_TEXT_BINDINGS.filter((name) => {
    const binding = (resources.bindings as readonly unknown[]).find(
      (candidate) =>
        isRecord(candidate) && candidate.name === name && candidate.type === "plain_text",
    );
    return !isRecord(binding) || binding.text !== expectedDatabaseBindings.get(name);
  });
  if (missingBindings.length > 0 || mismatchedDatabaseBindings.length > 0) {
    throw new CloudflareRuntimeReleaseVerificationError(
      "cloudflare_runtime_release_bindings_unready",
      "versions-view",
    );
  }
  return {
    semantics: CLOUDFLARE_RUNTIME_RELEASE_VERIFIER_SEMANTICS,
    verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
    expectedCommit: options.expectedCommit,
    expectedTree: options.expectedTree,
    deploymentId: deployment.id,
    versionId,
    createdOn: metadata.created_on,
    sourceMessage: expectedMessage,
    sourceTag: expectedTag,
    bindings: REQUIRED_BINDINGS.map(([name]) => name),
  };
}
