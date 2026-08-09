import { ContainerProxy as SandboxContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import { createHash } from "node:crypto";
import { memoryUsage } from "node:process";
import {
  argvToCommandString,
  canonicalPantryJson,
  compareUtf8,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  sha256Hex,
  validateRuntimeArtifactPath,
} from "@workspace/tenant-runtime-contracts";
import type {
  TrustedBuildCollectionProgress,
  TrustedBuildCommandDiagnostics,
  TrustedBuildMemoryProgress,
  TrustedBuildSecretScanFinding,
  TrustedBuildStage,
} from "@workspace/tenant-runtime-contracts";
import type {
  TrustedBuildCell,
  TrustedBuildCellFile,
  TrustedBuildCellInput,
  TrustedBuildCellCollection,
  TrustedBuildCellResult,
  TrustedBuildWorkerBindings,
} from "./trusted-build-model";
import { putTrustedBuildObject, trustedBuildStagingChunkKey } from "./trusted-build-storage";

const BUILD_ROOT = "/workspace/.nabuflow-build";
const MAX_LISTED_FILES = 25_000;
const MAX_COLLECTED_BYTES = 128 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 3 * 60 * 1_000;
const LOCAL_REGISTRY_PORT = 4873;
const BUILD_EXECUTION_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DIAGNOSTIC_TAIL_BYTES = 4_096;
const COLLECTION_HEARTBEAT_MS = 10_000;
const COLLECTION_PAYLOAD_BYTES = 8 * 1024 * 1024;
const COLLECTION_FORMAT = "nabu-trusted-build-collection/v1";
const INPUT_STREAM_CHUNK_BYTES = 1024 * 1024;
const BUILD_CELL_STAGES = [
  "initialize",
  "keepalive",
  "filesystem-initialize",
  "source-transfer",
  "pantry-transfer",
  "resource-transfer",
  "registry-start",
  "registry-ready",
  "toolchain-resolve",
  "install",
  "bin-materialization",
  "rebuild",
  "post-rebuild-bin-materialization",
  "build-command",
  "post-build-bin-materialization",
  "output-collection",
] as const;
type BuildCellStage = (typeof BUILD_CELL_STAGES)[number] | "unknown";

const BIN_SHIM_PREFIX = `#!/bin/sh
set -eu
basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=`;
const BIN_SHIM_SUFFIX = `
exec "$basedir/$target" "$@"
`;

function normalizeTrustedBuildBinTarget(relativeTarget: string): string {
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith("/") ||
    relativeTarget.includes("\\") ||
    /[\0\r\n]/u.test(relativeTarget)
  ) {
    throw new Error("Bin targets must be safe relative paths");
  }
  const normalized: string[] = [];
  for (const segment of relativeTarget.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && normalized.at(-1) !== undefined && normalized.at(-1) !== "..") {
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }
  if (normalized.length === 0 || normalized.every((segment) => segment === "..")) {
    throw new Error("Bin targets must resolve to package files");
  }
  return normalized.join("/");
}

function quotePosixAssignment(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function trustedBuildBinShim(relativeTarget: string): {
  bytes: Uint8Array;
  mode: 0o755;
} {
  const normalized = normalizeTrustedBuildBinTarget(relativeTarget);
  return {
    bytes: new TextEncoder().encode(
      `${BIN_SHIM_PREFIX}${quotePosixAssignment(normalized)}${BIN_SHIM_SUFFIX}`,
    ),
    mode: 0o755,
  };
}

type TrustedBuildPackageTarball = TrustedBuildCellInput["packageTarballs"][number];

type MemoryPhase = TrustedBuildMemoryProgress["phase"];
type RpcDisposable = { [Symbol.dispose]?: () => void };

function runtimeMemorySnapshot(): {
  runtimeBytes: number | null;
  heapUsedBytes: number | null;
  arrayBuffersBytes: number | null;
} {
  try {
    const snapshot = memoryUsage();
    return {
      runtimeBytes: Number.isSafeInteger(snapshot.rss) ? snapshot.rss : null,
      heapUsedBytes: Number.isSafeInteger(snapshot.heapUsed) ? snapshot.heapUsed : null,
      arrayBuffersBytes: Number.isSafeInteger(snapshot.arrayBuffers) ? snapshot.arrayBuffers : null,
    };
  } catch {
    return { runtimeBytes: null, heapUsedBytes: null, arrayBuffersBytes: null };
  }
}

export class TrustedBuildPassResourceScope {
  private readonly disposables: RpcDisposable[] = [];
  private readonly abortControllers = new Set<AbortController>();
  private controlledBytes = 0;
  private controlledPeakBytes = 0;
  private closed = false;

  constructor(
    private readonly pass: 1 | 2,
    private readonly onMemoryProgress?: (progress: TrustedBuildMemoryProgress) => Promise<void>,
  ) {}

  trackRpc<T>(resource: T): T {
    if (
      typeof resource === "object" &&
      resource !== null &&
      typeof (resource as RpcDisposable)[Symbol.dispose] === "function"
    ) {
      this.disposables.push(resource as RpcDisposable);
    }
    return resource;
  }

  disposeRpc(resource: unknown): void {
    if (typeof resource !== "object" || resource === null) return;
    const disposable = resource as RpcDisposable;
    const index = this.disposables.lastIndexOf(disposable);
    if (index >= 0) this.disposables.splice(index, 1);
    try {
      disposable[Symbol.dispose]?.();
    } catch {
      // RPC disposal is best-effort only after the owned operation has ended.
    }
  }

  trackAbortController(controller: AbortController): AbortController {
    this.abortControllers.add(controller);
    return controller;
  }

  releaseAbortController(controller: AbortController): void {
    this.abortControllers.delete(controller);
  }

  retain(bytes: number): void {
    this.controlledBytes += bytes;
    this.controlledPeakBytes = Math.max(this.controlledPeakBytes, this.controlledBytes);
  }

  release(bytes: number): void {
    this.controlledBytes = Math.max(0, this.controlledBytes - bytes);
  }

  async sample(phase: MemoryPhase, controlledPeakBytes = this.controlledPeakBytes): Promise<void> {
    if (this.onMemoryProgress === undefined) return;
    const memory = runtimeMemorySnapshot();
    await this.onMemoryProgress({
      pass: this.pass,
      phase,
      controlledPeakBytes: Math.max(this.controlledPeakBytes, controlledPeakBytes),
      runtimePeakBytes: memory.runtimeBytes,
      heapUsedBytes: memory.heapUsedBytes,
      arrayBuffersBytes: memory.arrayBuffersBytes,
      samples: 1,
      recordedAt: new Date().toISOString(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    for (const disposable of this.disposables.reverse()) {
      try {
        disposable[Symbol.dispose]?.();
      } catch {
        // Teardown must continue so every remaining pass capability is released.
      }
    }
    this.disposables.length = 0;
    this.controlledBytes = 0;
  }
}

export async function consumeTrustedBuildRpcResult<T, R>(
  scope: TrustedBuildPassResourceScope,
  pending: Promise<T>,
  consume: (result: T) => R | Promise<R>,
): Promise<R> {
  const result = scope.trackRpc(await pending);
  try {
    return await consume(result);
  } finally {
    scope.disposeRpc(result);
  }
}

export function trustedBuildRegistryVersion(
  ingredient: TrustedBuildPackageTarball,
): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  const optionalDependencies: Record<string, string> = {};
  const peerDependencies: Record<string, string> = {};
  for (const dependency of ingredient.dependencies) {
    const target =
      dependency.kind === "optional"
        ? optionalDependencies
        : dependency.kind === "peer"
          ? peerDependencies
          : dependencies;
    target[dependency.name] = dependency.version;
  }
  return {
    name: ingredient.name,
    version: ingredient.version,
    bin: ingredient.bins,
    dependencies,
    optionalDependencies,
    peerDependencies,
    dist: {
      integrity: ingredient.integrity,
      tarball: `http://127.0.0.1:${LOCAL_REGISTRY_PORT}/tarballs/${ingredient.sha256}.tgz`,
    },
  };
}

export function trustedBuildBinVerificationCommand(
  binDirectory: string,
  binNames: ReadonlyArray<string>,
): string {
  const effectivePath = `${binDirectory}:${BUILD_EXECUTION_PATH}`;
  const uniqueNames = [...new Set(binNames)].sort();
  if (uniqueNames.length === 0) return ":";
  return uniqueNames
    .flatMap((name) => [
      `test -x ${argvToCommandString([`${binDirectory}/${name}`])}`,
      `PATH=${argvToCommandString([effectivePath])} command -v ${argvToCommandString([name])} >/dev/null`,
    ])
    .join("; ");
}

const TRUSTED_BUILD_PIPELINE_STAGES = [
  "install",
  "bin-materialization",
  "rebuild",
  "post-rebuild-bin-materialization",
  "build-command",
  "post-build-bin-materialization",
] as const satisfies ReadonlyArray<BuildCellStage>;

async function recordPipelineFailure(
  stage: BuildCellStage,
  recordStage: (
    stage: BuildCellStage,
    outcome: "started" | "succeeded" | "failed",
  ) => Promise<unknown>,
): Promise<void> {
  const stageIndex = TRUSTED_BUILD_PIPELINE_STAGES.indexOf(
    stage as (typeof TRUSTED_BUILD_PIPELINE_STAGES)[number],
  );
  if (stageIndex < 0) {
    await recordStage(stage, "failed");
    return;
  }
  for (const completed of TRUSTED_BUILD_PIPELINE_STAGES.slice(0, stageIndex)) {
    await recordStage(completed, "succeeded");
  }
  if (stage !== "install") await recordStage(stage, "started");
  await recordStage(stage, "failed");
}

const BIN_SHIM_MATERIALIZER_SOURCE = `import { lstat, readdir, readlink, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const prefix = ${JSON.stringify(BIN_SHIM_PREFIX)};
const suffix = ${JSON.stringify(BIN_SHIM_SUFFIX)};
const quoteReplacement = ${JSON.stringify(`'"'"'`)};
const quote = (value) => "'" + value.replaceAll("'", quoteReplacement) + "'";
const normalizeTarget = (value) => {
  if (value === "" || isAbsolute(value) || value.includes("\\\\") || /[\\0\\r\\n]/u.test(value)) {
    throw new Error("unsafe bin target");
  }
  const normalized = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && normalized.at(-1) !== undefined && normalized.at(-1) !== "..") normalized.pop();
    else normalized.push(segment);
  }
  if (normalized.length === 0 || normalized.every((segment) => segment === "..")) {
    throw new Error("empty bin target");
  }
  return normalized.join("/");
};
const insideRoot = (candidate) => {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
};
const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isSymbolicLink() || basename(directory) !== ".bin") continue;
    const target = normalizeTarget(await readlink(path));
    const resolvedTarget = await realpath(resolve(directory, target));
    if (!insideRoot(resolvedTarget) || !(await lstat(resolvedTarget)).isFile()) {
      throw new Error("bin target escaped the dependency root");
    }
    const shim = prefix + quote(target) + suffix;
    await unlink(path);
    await writeFile(path, shim, { encoding: "utf8", flag: "wx", mode: 0o755 });
  }
};
await walk(root);
`;

const LOCAL_REGISTRY_SOURCE = String.raw`import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const root = process.env.NABUFLOW_PANTRY_ROOT;
if (!root) throw new Error("missing Pantry root");
const catalog = JSON.parse(await readFile(root + "/catalog.json", "utf8"));
const send = (response, status, body, type) => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": type,
  });
  response.end(body);
};
createServer((request, response) => {
  if (request.method !== "GET") return send(response, 405, Buffer.alloc(0), "text/plain");
  const path = decodeURIComponent(new URL(request.url, "http://pantry.local").pathname.slice(1));
  if (path.startsWith("tarballs/")) {
    const digest = path.slice("tarballs/".length).replace(/\.tgz$/u, "");
    const file = catalog.tarballs[digest];
    if (!file) return send(response, 404, Buffer.alloc(0), "text/plain");
    response.writeHead(200, { "cache-control": "immutable", "content-type": "application/octet-stream" });
    return createReadStream(root + "/" + file).pipe(response);
  }
  const packument = catalog.packuments[path];
  if (!packument) return send(response, 404, Buffer.alloc(0), "application/json");
  return send(response, 200, Buffer.from(JSON.stringify(packument)), "application/json");
}).listen(Number(process.env.NABUFLOW_PANTRY_PORT), "127.0.0.1", () => {
  process.stdout.write("pantry-loopback-ready\\n");
});
`;

// This program runs inside the secretless build cell. Its checks are advisory only: the Worker
// independently re-verifies the manifest, aggregate, chunks, files, paths, modes, and hashes.
const COLLECTION_AGGREGATOR_SOURCE = String.raw`import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const format = ${JSON.stringify(COLLECTION_FORMAT)};
const chunkBytes = ${COLLECTION_PAYLOAD_BYTES};
const maxFiles = ${MAX_LISTED_FILES};
const maxBytes = ${MAX_COLLECTED_BYTES};
const root = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? "");
if (root === "" || output === "" || root === output) throw new Error("invalid collection roots");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validPath = (value) => {
  if (
    value === "" ||
    value.length > 1024 ||
    value.includes(String.fromCharCode(92)) ||
    value.includes(String.fromCharCode(0)) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) return false;
  const parts = value.split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..");
};
const entries = [];
const walk = async (directory) => {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const child of children) {
    const absolute = join(directory, child.name);
    const status = await lstat(absolute);
    if (status.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!status.isFile()) throw new Error("forbidden collection entry");
    const path = relative(root, absolute).replaceAll(String.fromCharCode(92), "/");
    if (isAbsolute(path) || !validPath(path)) throw new Error("unsafe collection path");
    const bytes = await readFile(absolute);
    entries.push({ path, mode: (status.mode & 0o111) === 0 ? 420 : 493, bytes });
    if (entries.length > maxFiles) throw new Error("collection file limit exceeded");
  }
};
await walk(root);
entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
let payloadBytes = 0;
const files = [];
const payloadParts = [];
for (const entry of entries) {
  if (payloadBytes + entry.bytes.byteLength > maxBytes) throw new Error("collection byte limit exceeded");
  files.push({
    path: entry.path,
    mode: entry.mode,
    size: entry.bytes.byteLength,
    offset: payloadBytes,
    sha256: digest(entry.bytes),
  });
  payloadParts.push(entry.bytes);
  payloadBytes += entry.bytes.byteLength;
}
const payload = Buffer.concat(payloadParts, payloadBytes);
await mkdir(output, { recursive: true });
const chunks = [];
const writtenChunks = new Set();
for (let offset = 0, index = 0; offset < payload.byteLength; offset += chunkBytes, index += 1) {
  const bytes = payload.subarray(offset, Math.min(payload.byteLength, offset + chunkBytes));
  const sha256 = digest(bytes);
  const name = sha256 + ".bin";
  if (!writtenChunks.has(name)) {
    await writeFile(join(output, name), bytes, { flag: "wx" });
    writtenChunks.add(name);
  }
  chunks.push({ index, offset, size: bytes.byteLength, sha256, name });
}
const manifest = {
  format,
  payloadBytes,
  payloadSha256: digest(payload),
  chunks,
  files,
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
await writeFile(join(output, "manifest.json"), manifestBytes, { flag: "wx" });
await writeFile(join(output, "manifest.sha256"), digest(manifestBytes), { flag: "wx" });
`;

export class TrustedBuildSandbox extends Sandbox<TrustedBuildWorkerBindings> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts: string[] = [];
}

// The Sandbox container launcher resolves this exact export from the Worker entrypoint.
// Keeping the trusted build proxy separate from the tenant runtime proxy also preserves the
// build cell's empty outbound allowlist and prevents the tenant doorman handler from being wired.
export class TrustedBuildContainerProxy extends SandboxContainerProxy {}

export class TrustedBuildCellError extends Error {
  constructor(
    readonly code: "build_failed" | "build_timeout" | "build_resource_limit" | "build_unavailable",
    message: string,
    readonly stage: BuildCellStage = "unknown",
    readonly diagnostics: TrustedBuildCommandDiagnostics | null = null,
    readonly scanFindings: ReadonlyArray<TrustedBuildSecretScanFinding> = [],
  ) {
    super(message);
    this.name = "TrustedBuildCellError";
  }
}

async function readBuildStage(
  sandbox: TrustedBuildSandbox,
  path: string,
  fallback: BuildCellStage,
  scope: TrustedBuildPassResourceScope,
): Promise<BuildCellStage> {
  try {
    return await consumeTrustedBuildRpcResult(
      scope,
      sandbox.readFile(path, { encoding: "utf-8" }),
      (result) => {
        if (
          result.success &&
          result.encoding === "utf-8" &&
          BUILD_CELL_STAGES.includes(result.content.trim() as (typeof BUILD_CELL_STAGES)[number])
        ) {
          return result.content.trim() as (typeof BUILD_CELL_STAGES)[number];
        }
        return fallback;
      },
    );
  } catch {
    // Stage evidence is best-effort and must never replace the typed build failure.
  }
  return fallback;
}

export function sanitizeBuildDiagnosticText(
  value: string,
  maxBytes = DIAGNOSTIC_TAIL_BYTES,
): string {
  const scrubbed = value
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bsk_(?:test|live)_[A-Za-z0-9]{8,}\b/gu, "[REDACTED_STRIPE_KEY]")
    .replace(/\b(?:postgres|postgresql):\/\/[^\s:@/]+:[^\s@/]+@/gu, "postgresql://[REDACTED]@")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_AWS_KEY]");
  return scrubbed.length <= maxBytes ? scrubbed : scrubbed.slice(-maxBytes);
}

function commandDiagnostics(
  result: Awaited<ReturnType<TrustedBuildSandbox["exec"]>>,
  resolvedExecutable: string | null,
): TrustedBuildCommandDiagnostics {
  return {
    commandLine: sanitizeBuildDiagnosticText(result.command, 8_192),
    exitCode: result.exitCode,
    resolvedPath: BUILD_EXECUTION_PATH,
    resolvedExecutable,
    stdoutTail: sanitizeBuildDiagnosticText(result.stdout),
    stderrTail: sanitizeBuildDiagnosticText(result.stderr),
  };
}

async function recordBuildCellStage(
  buildId: string,
  pass: 1 | 2,
  stage: BuildCellStage,
  outcome: "started" | "succeeded" | "failed",
  onStage?: (
    stage: TrustedBuildStage,
    outcome: "started" | "succeeded" | "failed",
  ) => Promise<void>,
): Promise<void> {
  // Metadata only: package names, paths, source, commands, stdout/stderr, and environment values
  // are deliberately absent.
  // eslint-disable-next-line no-console -- trusted build stage audit
  console.log(
    JSON.stringify({ event: "trusted_build_stage_progress", buildId, pass, stage, outcome }),
  );
  await onStage?.(stage, outcome);
}

export async function initializeFreshBuildSandbox(
  sandbox: Pick<TrustedBuildSandbox, "setKeepAlive" | "exec">,
  passRoot: string,
  onStage: (
    stage: "keepalive" | "filesystem-initialize",
    outcome: "started" | "succeeded" | "failed",
  ) => Promise<void>,
  scope?: TrustedBuildPassResourceScope,
): Promise<void> {
  await onStage("keepalive", "started");
  try {
    const keepAlive = sandbox.setKeepAlive(true);
    if (scope === undefined) await keepAlive;
    else await consumeTrustedBuildRpcResult(scope, keepAlive, () => undefined);
    await onStage("keepalive", "succeeded");
  } catch (error) {
    await onStage("keepalive", "failed");
    if (error instanceof TrustedBuildCellError) throw error;
    throw new TrustedBuildCellError(
      "build_unavailable",
      "Build cell keepalive failed",
      "keepalive",
    );
  }
  await onStage("filesystem-initialize", "started");
  try {
    const initialize = sandbox.exec(
      argvToCommandString([
        "sh",
        "-c",
        `rm -rf ${argvToCommandString([passRoot])} && mkdir -p ${argvToCommandString([
          `${passRoot}/source`,
        ])} ${argvToCommandString([`${passRoot}/pantry/tarballs`])} ${argvToCommandString([
          `${passRoot}/cache`,
        ])} ${argvToCommandString([`${passRoot}/captured`])}`,
      ]),
      { timeout: 30_000 },
    );
    const verifyInitialized = (initialized: Awaited<typeof initialize>) => {
      if (!initialized.success) {
        throw new TrustedBuildCellError(
          "build_unavailable",
          "Build cell initialization failed",
          "filesystem-initialize",
        );
      }
    };
    if (scope === undefined) verifyInitialized(await initialize);
    else await consumeTrustedBuildRpcResult(scope, initialize, verifyInitialized);
    await onStage("filesystem-initialize", "succeeded");
  } catch (error) {
    await onStage("filesystem-initialize", "failed");
    if (error instanceof TrustedBuildCellError) throw error;
    throw new TrustedBuildCellError(
      "build_unavailable",
      "Build filesystem initialization became unavailable",
      "filesystem-initialize",
    );
  }
}

export async function destroyFreshBuildSandbox(
  sandbox: Pick<TrustedBuildSandbox, "destroy">,
): Promise<void> {
  await sandbox.destroy();
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return btoa(output);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeBuildId(value: string): string {
  if (!/^pbuild_[A-Za-z0-9_-]{22,128}$/u.test(value)) {
    throw new TrustedBuildCellError("build_failed", "Build identifier is invalid");
  }
  return value;
}

/**
 * Maps the shipped, variable-length build identity onto Cloudflare's DNS-label-sized Sandbox ID.
 * The 48-hex-character suffix retains 192 bits of SHA-256 collision resistance while leaving
 * eleven characters of margin beneath the platform's 63-character limit.
 */
export function trustedBuildSandboxCellId(buildId: string, attempt: number, pass: 1 | 2): string {
  const validatedBuildId = safeBuildId(buildId);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 10) {
    throw new TrustedBuildCellError("build_failed", "Build attempt is invalid");
  }
  const digest = createHash("sha256")
    .update(
      canonicalPantryJson({
        domain: "nabuflow-trusted-build-sandbox/v1",
        buildId: validatedBuildId,
        attempt,
        pass,
      }),
    )
    .digest("hex")
    .slice(0, 48);
  return `nbb-${digest}`;
}

async function writeBinary(
  sandbox: TrustedBuildSandbox,
  path: string,
  bytes: Uint8Array,
  scope: TrustedBuildPassResourceScope,
): Promise<void> {
  await consumeTrustedBuildRpcResult(
    scope,
    sandbox.writeFile(path, bytesToBase64(bytes), { encoding: "base64" }),
    (result) => {
      if (!result.success) {
        throw new TrustedBuildCellError("build_unavailable", "Build input could not be written");
      }
    },
  );
}

type TrustedBuildRangeFetcher = (
  offset: number,
  length: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export function verifiedInputStream(
  expectedBytes: number,
  expectedSha256: string,
  scope: TrustedBuildPassResourceScope,
  fetchRange: TrustedBuildRangeFetcher,
): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  let offset = 0;
  let retainedBytes = 0;
  let completed = false;
  const controller = scope.trackAbortController(new AbortController());
  const releaseRetained = () => {
    if (retainedBytes === 0) return;
    scope.release(retainedBytes);
    retainedBytes = 0;
  };
  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      releaseRetained();
      if (completed) return;
      if (offset === expectedBytes) {
        completed = true;
        scope.releaseAbortController(controller);
        if (hash.digest("hex") !== expectedSha256) {
          streamController.error(
            new TrustedBuildCellError("build_failed", "Build input integrity failed"),
          );
          return;
        }
        streamController.close();
        return;
      }
      const length = Math.min(INPUT_STREAM_CHUNK_BYTES, expectedBytes - offset);
      try {
        const bytes = await fetchRange(offset, length, controller.signal);
        if (bytes.byteLength !== length) {
          throw new TrustedBuildCellError("build_failed", "Build input integrity failed");
        }
        hash.update(bytes);
        offset += bytes.byteLength;
        retainedBytes = bytes.byteLength;
        scope.retain(retainedBytes);
        streamController.enqueue(bytes);
      } catch (error) {
        completed = true;
        releaseRetained();
        scope.releaseAbortController(controller);
        streamController.error(error);
      }
    },
    cancel() {
      completed = true;
      controller.abort();
      releaseRetained();
      scope.releaseAbortController(controller);
    },
  });
}

async function writeVerifiedInput(
  sandbox: TrustedBuildSandbox,
  destination: string,
  expectedBytes: number,
  expectedSha256: string,
  scope: TrustedBuildPassResourceScope,
  fetchRange: TrustedBuildRangeFetcher,
): Promise<void> {
  const stream = verifiedInputStream(expectedBytes, expectedSha256, scope, fetchRange);
  await consumeTrustedBuildRpcResult(scope, sandbox.writeFile(destination, stream), (result) => {
    if (
      !result.success ||
      ("bytesWritten" in result && result.bytesWritten !== expectedBytes) ||
      ("size" in result && typeof result.size === "number" && result.size !== expectedBytes)
    ) {
      throw new TrustedBuildCellError("build_unavailable", "Build input could not be written");
    }
  });
}

type BuildOutputEntry = {
  type: string;
  relativePath: string;
};

export function assertTrustedBuildOutputEntries(entries: ReadonlyArray<BuildOutputEntry>): void {
  for (const entry of entries) {
    if (entry.type !== "file" || validateRuntimeArtifactPath(entry.relativePath) === null) {
      throw new TrustedBuildCellError("build_failed", "Build output contains a forbidden entry");
    }
  }
}

interface TrustedBuildCollectionManifest {
  format: typeof COLLECTION_FORMAT;
  payloadBytes: number;
  payloadSha256: string;
  chunks: Array<{ index: number; offset: number; size: number; sha256: string; name: string }>;
  files: Array<{
    path: string;
    mode: 0o644 | 0o755;
    size: number;
    offset: number;
    sha256: string;
  }>;
}

export interface TrustedBuildCollectionEnvelope {
  manifestBytes: Uint8Array;
  manifestSha256: string;
  chunks: ReadonlyMap<string, Uint8Array>;
}

function collectionFailure(message = "Build collection integrity verification failed") {
  return new TrustedBuildCellError("build_failed", message, "output-collection");
}

function canonicalCollectionManifest(manifest: TrustedBuildCollectionManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      format: manifest.format,
      payloadBytes: manifest.payloadBytes,
      payloadSha256: manifest.payloadSha256,
      chunks: manifest.chunks.map((chunk) => ({
        index: chunk.index,
        offset: chunk.offset,
        size: chunk.size,
        sha256: chunk.sha256,
        name: chunk.name,
      })),
      files: manifest.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        size: file.size,
        offset: file.offset,
        sha256: file.sha256,
      })),
    }),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function parseCollectionManifest(bytes: Uint8Array): TrustedBuildCollectionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw collectionFailure();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw collectionFailure();
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.format !== COLLECTION_FORMAT ||
    !Number.isSafeInteger(value.payloadBytes) ||
    (value.payloadBytes as number) < 0 ||
    (value.payloadBytes as number) > MAX_COLLECTED_BYTES ||
    typeof value.payloadSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.payloadSha256) ||
    !Array.isArray(value.chunks) ||
    !Array.isArray(value.files) ||
    value.chunks.length > Math.ceil(MAX_COLLECTED_BYTES / COLLECTION_PAYLOAD_BYTES) ||
    value.files.length > MAX_LISTED_FILES
  ) {
    throw collectionFailure();
  }
  const chunks = value.chunks.map((candidate, expectedIndex) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw collectionFailure();
    }
    const chunk = candidate as Record<string, unknown>;
    if (
      chunk.index !== expectedIndex ||
      !Number.isSafeInteger(chunk.offset) ||
      !Number.isSafeInteger(chunk.size) ||
      (chunk.offset as number) < 0 ||
      (chunk.size as number) <= 0 ||
      (chunk.size as number) > COLLECTION_PAYLOAD_BYTES ||
      typeof chunk.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(chunk.sha256) ||
      chunk.name !== `${chunk.sha256}.bin`
    ) {
      throw collectionFailure();
    }
    return {
      index: expectedIndex,
      offset: chunk.offset as number,
      size: chunk.size as number,
      sha256: chunk.sha256,
      name: chunk.name as string,
    };
  });
  const files = value.files.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw collectionFailure();
    }
    const file = candidate as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      validateRuntimeArtifactPath(file.path) === null ||
      (file.mode !== 0o644 && file.mode !== 0o755) ||
      !Number.isSafeInteger(file.size) ||
      !Number.isSafeInteger(file.offset) ||
      (file.size as number) < 0 ||
      (file.offset as number) < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw collectionFailure();
    }
    return {
      path: file.path,
      mode: file.mode,
      size: file.size as number,
      offset: file.offset as number,
      sha256: file.sha256,
    } as TrustedBuildCollectionManifest["files"][number];
  });
  const manifest: TrustedBuildCollectionManifest = {
    format: COLLECTION_FORMAT,
    payloadBytes: value.payloadBytes as number,
    payloadSha256: value.payloadSha256,
    chunks,
    files,
  };
  if (!equalBytes(bytes, canonicalCollectionManifest(manifest))) throw collectionFailure();
  return manifest;
}

export async function createTrustedBuildCollection(
  inputFiles: ReadonlyArray<TrustedBuildCellFile>,
): Promise<TrustedBuildCollectionEnvelope> {
  const files = inputFiles
    .map((file) => ({ path: file.path, mode: file.mode, bytes: new Uint8Array(file.bytes) }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  assertTrustedBuildOutputEntries(files.map((file) => ({ type: "file", relativePath: file.path })));
  const payloadBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (files.length > MAX_LISTED_FILES || payloadBytes > MAX_COLLECTED_BYTES) {
    throw new TrustedBuildCellError(
      "build_resource_limit",
      "Build collection exceeded its resource limit",
      "output-collection",
    );
  }
  const payload = new Uint8Array(payloadBytes);
  const manifestFiles: TrustedBuildCollectionManifest["files"] = [];
  let offset = 0;
  for (const file of files) {
    payload.set(file.bytes, offset);
    manifestFiles.push({
      path: file.path,
      mode: file.mode,
      size: file.bytes.byteLength,
      offset,
      sha256: await sha256Hex(file.bytes),
    });
    offset += file.bytes.byteLength;
  }
  const chunks = new Map<string, Uint8Array>();
  const descriptors: TrustedBuildCollectionManifest["chunks"] = [];
  for (let start = 0, index = 0; start < payload.byteLength; start += COLLECTION_PAYLOAD_BYTES) {
    const bytes = payload.slice(start, start + COLLECTION_PAYLOAD_BYTES);
    const sha256 = await sha256Hex(bytes);
    const name = `${sha256}.bin`;
    chunks.set(name, bytes);
    descriptors.push({ index, offset: start, size: bytes.byteLength, sha256, name });
    index += 1;
  }
  const manifestBytes = canonicalCollectionManifest({
    format: COLLECTION_FORMAT,
    payloadBytes,
    payloadSha256: await sha256Hex(payload),
    chunks: descriptors,
    files: manifestFiles,
  });
  return { manifestBytes, manifestSha256: await sha256Hex(manifestBytes), chunks };
}

export async function verifyTrustedBuildCollection(
  envelope: TrustedBuildCollectionEnvelope,
): Promise<TrustedBuildCellFile[]> {
  if (
    !/^[0-9a-f]{64}$/u.test(envelope.manifestSha256) ||
    (await sha256Hex(envelope.manifestBytes)) !== envelope.manifestSha256
  ) {
    throw collectionFailure();
  }
  const manifest = parseCollectionManifest(envelope.manifestBytes);
  let nextChunkOffset = 0;
  const payload = new Uint8Array(manifest.payloadBytes);
  for (const descriptor of manifest.chunks) {
    const bytes = envelope.chunks.get(descriptor.name);
    if (
      descriptor.offset !== nextChunkOffset ||
      bytes === undefined ||
      bytes.byteLength !== descriptor.size ||
      (await sha256Hex(bytes)) !== descriptor.sha256
    ) {
      throw collectionFailure();
    }
    payload.set(bytes, descriptor.offset);
    nextChunkOffset += descriptor.size;
  }
  if (
    nextChunkOffset !== manifest.payloadBytes ||
    (manifest.payloadBytes > 0 && manifest.chunks.length === 0) ||
    (await sha256Hex(payload)) !== manifest.payloadSha256
  ) {
    throw collectionFailure();
  }
  let nextFileOffset = 0;
  let previousPath: string | null = null;
  const files: TrustedBuildCellFile[] = [];
  for (const descriptor of manifest.files) {
    if (
      descriptor.offset !== nextFileOffset ||
      descriptor.offset + descriptor.size > payload.byteLength ||
      (previousPath !== null && compareUtf8(previousPath, descriptor.path) >= 0)
    ) {
      throw collectionFailure();
    }
    const bytes = payload.slice(descriptor.offset, descriptor.offset + descriptor.size);
    if ((await sha256Hex(bytes)) !== descriptor.sha256) throw collectionFailure();
    files.push({ path: descriptor.path, mode: descriptor.mode, bytes });
    nextFileOffset += descriptor.size;
    previousPath = descriptor.path;
  }
  if (nextFileOffset !== manifest.payloadBytes) throw collectionFailure();
  assertTrustedBuildOutputEntries(files.map((file) => ({ type: "file", relativePath: file.path })));
  return files;
}

const OUTPUT_FORBIDDEN_PATHS = [
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u,
  /(?:^|\/)credentials(?:\.|$)/u,
] as const;
const STREAM_SCAN_WINDOW_BYTES = 2_048;
const STREAM_SCAN_BLOCK_BYTES = 64 * 1_024;
const STREAM_SECRET_PATTERNS = [
  { ruleId: "private-key", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u },
  { ruleId: "stripe-secret-key", pattern: /\bsk_(?:test|live)_[A-Za-z0-9]{16,256}\b/u },
  {
    ruleId: "postgres-credential-url",
    pattern: /\b(?:postgres|postgresql):\/\/[^\s:@/]{1,512}:[^\s@/]{1,512}@/u,
  },
  { ruleId: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
] as const satisfies ReadonlyArray<{
  ruleId: TrustedBuildSecretScanFinding["ruleId"];
  pattern: RegExp;
}>;
const latin1Decoder = new TextDecoder("windows-1252", { fatal: false });

function sanitizedScanPath(path: string): string {
  return STREAM_SECRET_PATTERNS.some(({ pattern }) => pattern.test(path))
    ? "[redacted-path]"
    : path;
}

interface StreamingScanState {
  tail: string;
  processedBytes: number;
  reportedRules: Set<TrustedBuildSecretScanFinding["ruleId"]>;
}

function scanStreamingBytes(
  state: StreamingScanState,
  bytes: Uint8Array,
  finding: Omit<TrustedBuildSecretScanFinding, "ruleId" | "byteOffset">,
  findings: TrustedBuildSecretScanFinding[],
): void {
  for (let start = 0; start < bytes.byteLength; start += STREAM_SCAN_BLOCK_BYTES) {
    const block = bytes.subarray(start, start + STREAM_SCAN_BLOCK_BYTES);
    const text = latin1Decoder.decode(block);
    const combined = state.tail + text;
    const combinedOffset = state.processedBytes - state.tail.length;
    for (const { ruleId, pattern } of STREAM_SECRET_PATTERNS) {
      if (state.reportedRules.has(ruleId)) continue;
      const match = pattern.exec(combined);
      if (match !== null && findings.length < 100) {
        findings.push({ ...finding, ruleId, byteOffset: combinedOffset + match.index });
        state.reportedRules.add(ruleId);
      }
    }
    state.processedBytes += block.byteLength;
    state.tail = combined.slice(-(STREAM_SCAN_WINDOW_BYTES - 1));
  }
}

export function scanTrustedBuildFileStream(input: {
  path: string;
  sha256: string;
  scope: "app" | "dependency";
  chunks: ReadonlyArray<Uint8Array>;
  shelfContentSha256: ReadonlySet<string>;
}): { findings: TrustedBuildSecretScanFinding[]; scannedBytes: number; shelfExempt: boolean } {
  if (input.shelfContentSha256.has(input.sha256)) {
    return { findings: [], scannedBytes: 0, shelfExempt: true };
  }
  const findings: TrustedBuildSecretScanFinding[] = [];
  const state: StreamingScanState = { tail: "", processedBytes: 0, reportedRules: new Set() };
  let scannedBytes = 0;
  for (const chunk of input.chunks) {
    scanStreamingBytes(
      state,
      chunk,
      {
        scope: input.scope,
        path: sanitizedScanPath(input.path),
        contentSha256Prefix: input.sha256.slice(0, 16),
        provenance: "not-shelf-byte-identical",
      },
      findings,
    );
    scannedBytes += chunk.byteLength;
  }
  return { findings, scannedBytes, shelfExempt: false };
}

async function collectFiles(
  sandbox: TrustedBuildSandbox,
  bucket: R2Bucket,
  scope: TrustedBuildPassResourceScope,
  root: string,
  aggregatorPath: string,
  aggregateRoot: string,
  collectionRoot: TrustedBuildCollectionProgress["root"],
  pass: 1 | 2,
  buildId: string,
  attempt: number,
  shelfContentSha256: ReadonlySet<string>,
  onProgress?: (progress: TrustedBuildCollectionProgress) => Promise<void>,
): Promise<TrustedBuildCellCollection> {
  const startedAt = Date.now();
  let filesEnumerated = 0;
  let filesCollected = 0;
  let totalBytes = 0;
  let peakBufferedBytes = 0;
  let telemetryWrites = Promise.resolve();
  const emit = (
    phase: TrustedBuildCollectionProgress["phase"],
    batchFiles = 0,
    batchBytes = 0,
    batchElapsedMs = 0,
  ): void => {
    const progress: TrustedBuildCollectionProgress = {
      pass,
      root: collectionRoot,
      phase,
      filesEnumerated,
      filesCollected,
      bytesMoved: totalBytes,
      peakBufferedBytes,
      batchFiles,
      batchBytes,
      batchElapsedMs,
      elapsedMs: Date.now() - startedAt,
      recordedAt: new Date().toISOString(),
    };
    // Metadata only: filenames and file contents are deliberately absent.
    // eslint-disable-next-line no-console -- trusted build collection telemetry
    console.log(
      JSON.stringify({ event: "trusted_build_collection_progress", buildId, ...progress }),
    );
    if (onProgress !== undefined) {
      telemetryWrites = telemetryWrites
        .then(() => onProgress(progress))
        .catch(() => {
          // Progress telemetry is diagnostic and must never replace the build result.
        });
    }
  };
  const heartbeat = setInterval(() => emit("heartbeat"), COLLECTION_HEARTBEAT_MS);
  try {
    await consumeTrustedBuildRpcResult(
      scope,
      sandbox.exec(argvToCommandString(["node", aggregatorPath, root, aggregateRoot]), {
        timeout: 180_000,
      }),
      (aggregate) => {
        if (!aggregate.success) {
          throw new TrustedBuildCellError(
            aggregate.exitCode === 124 || aggregate.exitCode === 137
              ? "build_timeout"
              : "build_failed",
            "Build output aggregation failed",
            "output-collection",
            commandDiagnostics(aggregate, "node"),
          );
        }
      },
    );
    const [manifestResult, digestResult] = await Promise.all([
      sandbox.readFile(`${aggregateRoot}/manifest.json`, { encoding: "base64" }),
      sandbox.readFile(`${aggregateRoot}/manifest.sha256`, { encoding: "utf-8" }),
    ]);
    scope.trackRpc(manifestResult);
    scope.trackRpc(digestResult);
    let manifestBytes: Uint8Array;
    let expectedManifestSha256: string;
    try {
      if (
        !manifestResult.success ||
        manifestResult.encoding !== "base64" ||
        !digestResult.success ||
        digestResult.encoding !== "utf-8"
      ) {
        throw collectionFailure();
      }
      manifestBytes = base64ToBytes(manifestResult.content);
      expectedManifestSha256 = digestResult.content.trim();
    } finally {
      scope.disposeRpc(digestResult);
      scope.disposeRpc(manifestResult);
    }
    if ((await sha256Hex(manifestBytes)) !== expectedManifestSha256) throw collectionFailure();
    const manifest = parseCollectionManifest(manifestBytes);
    filesEnumerated = manifest.files.length;
    emit("enumerated");
    if (manifest.files.length === 0) {
      throw new TrustedBuildCellError("build_failed", "Build output is empty", "output-collection");
    }
    for (const file of manifest.files) {
      if (OUTPUT_FORBIDDEN_PATHS.some((pattern) => pattern.test(file.path))) {
        throw new TrustedBuildCellError(
          "build_failed",
          "Build output contains an invalid path",
          "output-collection",
        );
      }
    }
    const aggregateHasher = createHash("sha256");
    let fileIndex = 0;
    let fileConsumed = 0;
    let fileHasher = createHash("sha256");
    let fileScanState: StreamingScanState = {
      tail: "",
      processedBytes: 0,
      reportedRules: new Set(),
    };
    let scannedFiles = 0;
    let shelfExemptFiles = 0;
    let bytesScanned = 0;
    peakBufferedBytes = manifestBytes.byteLength;
    const findings: TrustedBuildSecretScanFinding[] = [];
    const outputChunks: TrustedBuildCellCollection["outputChunks"] = [];
    let outputBuffer = pass === 2 ? new Uint8Array(RUNTIME_ARTIFACT_CHUNK_BYTES) : null;
    let outputBuffered = 0;
    let outputIndex = 0;
    const finalizeFile = (): void => {
      const file = manifest.files[fileIndex];
      if (
        file === undefined ||
        fileConsumed !== file.size ||
        fileHasher.digest("hex") !== file.sha256
      ) {
        throw collectionFailure();
      }
      if (shelfContentSha256.has(file.sha256)) shelfExemptFiles += 1;
      else scannedFiles += 1;
      fileIndex += 1;
      fileConsumed = 0;
      fileHasher = createHash("sha256");
      fileScanState = { tail: "", processedBytes: 0, reportedRules: new Set() };
    };
    const finalizeZeroFiles = (): void => {
      while (manifest.files[fileIndex]?.size === 0) finalizeFile();
    };
    const storeOutputChunk = async (): Promise<void> => {
      if (outputBuffer === null || outputBuffered === 0) return;
      const bytes = outputBuffer.slice(0, outputBuffered);
      const sha256 = await sha256Hex(bytes);
      const stagingKey = trustedBuildStagingChunkKey(
        buildId,
        attempt,
        pass,
        collectionRoot,
        outputIndex,
        sha256,
      );
      await putTrustedBuildObject(bucket, stagingKey, bytes, sha256);
      outputChunks.push({ index: outputIndex, sha256, bytes: bytes.byteLength, stagingKey });
      outputIndex += 1;
      outputBuffer = new Uint8Array(RUNTIME_ARTIFACT_CHUNK_BYTES);
      outputBuffered = 0;
    };
    finalizeZeroFiles();
    for (const descriptor of manifest.chunks) {
      const batchStartedAt = Date.now();
      const result = scope.trackRpc(
        await sandbox.readFile(`${aggregateRoot}/${descriptor.name}`, { encoding: "base64" }),
      );
      let bytes: Uint8Array;
      let encodedCharacters: number;
      try {
        if (!result.success || result.encoding !== "base64") throw collectionFailure();
        bytes = base64ToBytes(result.content);
        encodedCharacters = result.content.length;
      } finally {
        scope.disposeRpc(result);
      }
      if (bytes.byteLength !== descriptor.size || (await sha256Hex(bytes)) !== descriptor.sha256) {
        throw collectionFailure();
      }
      aggregateHasher.update(bytes);
      let cursor = 0;
      while (cursor < bytes.byteLength) {
        const file = manifest.files[fileIndex];
        if (file === undefined) throw collectionFailure();
        const take = Math.min(file.size - fileConsumed, bytes.byteLength - cursor);
        const slice = bytes.subarray(cursor, cursor + take);
        fileHasher.update(slice);
        if (!shelfContentSha256.has(file.sha256)) {
          scanStreamingBytes(
            fileScanState,
            slice,
            {
              scope: collectionRoot === "app" ? "app" : "dependency",
              path: sanitizedScanPath(file.path),
              contentSha256Prefix: file.sha256.slice(0, 16),
              provenance: "not-shelf-byte-identical",
            },
            findings,
          );
          bytesScanned += take;
        }
        fileConsumed += take;
        cursor += take;
        if (fileConsumed === file.size) {
          finalizeFile();
          finalizeZeroFiles();
        }
      }
      if (outputBuffer !== null) {
        let outputCursor = 0;
        while (outputCursor < bytes.byteLength) {
          const take = Math.min(
            outputBuffer.byteLength - outputBuffered,
            bytes.byteLength - outputCursor,
          );
          outputBuffer.set(bytes.subarray(outputCursor, outputCursor + take), outputBuffered);
          outputBuffered += take;
          outputCursor += take;
          if (outputBuffered === outputBuffer.byteLength) await storeOutputChunk();
        }
      }
      peakBufferedBytes = Math.max(
        peakBufferedBytes,
        manifestBytes.byteLength +
          bytes.byteLength +
          encodedCharacters * 2 +
          (outputBuffer?.byteLength ?? 0) +
          STREAM_SCAN_WINDOW_BYTES,
      );
      const beforeFiles = filesCollected;
      filesCollected = manifest.files.filter(
        (file) => file.offset + file.size <= descriptor.offset + descriptor.size,
      ).length;
      totalBytes += bytes.byteLength;
      emit("batch", filesCollected - beforeFiles, bytes.byteLength, Date.now() - batchStartedAt);
    }
    await storeOutputChunk();
    if (
      fileIndex !== manifest.files.length ||
      fileConsumed !== 0 ||
      aggregateHasher.digest("hex") !== manifest.payloadSha256
    ) {
      throw collectionFailure();
    }
    if (findings.length > 0) {
      throw new TrustedBuildCellError(
        "build_failed",
        "Build output secret scan failed",
        "output-collection",
        null,
        findings,
      );
    }
    filesCollected = manifest.files.length;
    totalBytes = manifest.payloadBytes;
    emit("completed");
    await telemetryWrites;
    const determinismManifestSha256 = await sha256Hex(
      canonicalPantryJson({
        files: manifest.files.map((file) => ({
          path: file.path,
          mode: file.mode,
          size: file.size,
          sha256: file.sha256,
        })),
      }),
    );
    // Metadata only: paths, content, and matched text are deliberately absent.
    // eslint-disable-next-line no-console -- trusted build scan summary
    console.log(
      JSON.stringify({
        event: "trusted_build_secret_scan_summary",
        buildId,
        pass,
        root: collectionRoot,
        scannedFiles,
        shelfExemptFiles,
        bytesScanned,
        peakBufferedBytes,
      }),
    );
    return {
      payloadBytes: manifest.payloadBytes,
      payloadSha256: manifest.payloadSha256,
      determinismManifestSha256,
      files: manifest.files,
      outputChunks,
      scannedFiles,
      shelfExemptFiles,
      bytesScanned,
      peakBufferedBytes,
    };
  } finally {
    clearInterval(heartbeat);
    await telemetryWrites;
  }
}

export function trustedBuildExecutionCommand(command: string, capturedResourceMap: string): string {
  const constrainedShell = [
    "ulimit -t 120",
    "ulimit -n 256",
    "ulimit -f 262144",
    `exec ${argvToCommandString(["sh", "-c", command])}`,
  ].join("; ");
  return argvToCommandString([
    "timeout",
    "--signal=KILL",
    "180",
    "env",
    "-i",
    "HOME=/tmp",
    `PATH=${BUILD_EXECUTION_PATH}`,
    "CI=1",
    "NPM_CONFIG_UPDATE_NOTIFIER=false",
    "NPM_CONFIG_AUDIT=false",
    "NPM_CONFIG_FUND=false",
    "NABUFLOW_BUILD_SECRETLESS=1",
    `NABUFLOW_CAPTURED_RESOURCE_MAP=${capturedResourceMap}`,
    "sh",
    "-c",
    constrainedShell,
  ]);
}

export class CloudflareTrustedBuildCell implements TrustedBuildCell {
  private readonly sandbox: TrustedBuildSandbox;
  private readonly bucket: R2Bucket;
  private readonly pantry: Fetcher;
  private readonly cellId: string;
  private readonly buildId: string;
  private scope: TrustedBuildPassResourceScope | null = null;

  constructor(env: TrustedBuildWorkerBindings, buildId: string, attempt: number, pass: 1 | 2) {
    this.buildId = safeBuildId(buildId);
    this.cellId = trustedBuildSandboxCellId(this.buildId, attempt, pass);
    this.sandbox = getSandbox(env.TRUSTED_BUILD_SANDBOX, this.cellId, {
      normalizeId: true,
      keepAlive: true,
      sleepAfter: "10m",
      transport: "rpc",
    }) as TrustedBuildSandbox;
    this.bucket = env.TRUSTED_BUILD_OBJECTS;
    this.pantry = env.PANTRY_CATALOG;
  }

  private async pantryRange(
    sha256: string,
    totalBytes: number,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const end = offset + length - 1;
    const response = await this.pantry.fetch(
      new Request(`https://pantry.internal/internal/v1/objects/${sha256}`, {
        method: "GET",
        signal,
        headers: {
          range: `bytes=${offset}-${end}`,
          "x-nabuflow-pantry-principal": "builder-readonly",
        },
      }),
    );
    if (
      response.status !== 206 ||
      response.headers.get("content-length") !== String(length) ||
      response.headers.get("content-range") !== `bytes ${offset}-${end}/${totalBytes}` ||
      response.headers.get("x-nabuflow-content-sha256") !== sha256 ||
      response.headers.has("set-cookie")
    ) {
      throw new TrustedBuildCellError("build_unavailable", "Pantry input range is unavailable");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== length) {
      throw new TrustedBuildCellError("build_failed", "Build input integrity failed");
    }
    return bytes;
  }

  private async sourceRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    const object = await this.bucket.get(key, { range: { offset, length } });
    if (object === null) {
      throw new TrustedBuildCellError("build_unavailable", "Build source is unavailable");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== length) {
      throw new TrustedBuildCellError("build_failed", "Build input integrity failed");
    }
    return bytes;
  }

  async build(
    input: TrustedBuildCellInput,
    pass: 1 | 2,
    onStage?: (
      stage: TrustedBuildStage,
      outcome: "started" | "succeeded" | "failed",
    ) => Promise<void>,
    onCollectionProgress?: (progress: TrustedBuildCollectionProgress) => Promise<void>,
    onMemoryProgress?: (progress: TrustedBuildMemoryProgress) => Promise<void>,
  ): Promise<TrustedBuildCellResult> {
    if (this.scope !== null) {
      throw new TrustedBuildCellError("build_unavailable", "Build pass scope was reused");
    }
    const scope = new TrustedBuildPassResourceScope(pass, onMemoryProgress);
    this.scope = scope;
    scope.trackRpc(this.sandbox);
    const started = Date.now();
    const passRoot = `${BUILD_ROOT}/${this.cellId}/pass-${pass}`;
    const recordStage = (stage: BuildCellStage, outcome: "started" | "succeeded" | "failed") =>
      recordBuildCellStage(this.buildId, pass, stage, outcome, onStage);
    const runStage = async <T>(stage: BuildCellStage, operation: () => Promise<T>): Promise<T> => {
      await recordStage(stage, "started");
      try {
        const result = await operation();
        await recordStage(stage, "succeeded");
        return result;
      } catch (error) {
        if (
          !(error instanceof TrustedBuildCellError) ||
          error.stage === "unknown" ||
          error.stage === stage
        ) {
          try {
            await recordStage(stage, "failed");
          } catch {
            // Preserve the original stage failure when durable evidence recording is unavailable.
          }
        }
        if (error instanceof TrustedBuildCellError && error.stage === "unknown") {
          throw new TrustedBuildCellError(error.code, error.message, stage, error.diagnostics);
        }
        throw error;
      }
    };
    await runStage("initialize", () =>
      initializeFreshBuildSandbox(
        this.sandbox,
        passRoot,
        (stage, outcome) => recordStage(stage, outcome),
        scope,
      ),
    );

    await runStage("source-transfer", async () => {
      for (const file of input.request.source.manifest.files) {
        const destination = `${passRoot}/source/${file.path}`;
        const parent = destination.slice(0, destination.lastIndexOf("/"));
        await consumeTrustedBuildRpcResult(
          scope,
          this.sandbox.mkdir(parent, { recursive: true }),
          (directory) => {
            if (!directory.success) {
              throw new TrustedBuildCellError("build_unavailable", "Build source directory failed");
            }
          },
        );
        await writeVerifiedInput(
          this.sandbox,
          destination,
          file.size,
          file.sha256,
          scope,
          (relativeOffset, length) =>
            this.sourceRange(input.source.objectKey, file.offset + relativeOffset, length),
        );
        if (file.mode === 0o755) {
          await consumeTrustedBuildRpcResult(
            scope,
            this.sandbox.exec(argvToCommandString(["chmod", "755", destination]), {
              timeout: 10_000,
            }),
            (chmod) => {
              if (!chmod.success) {
                throw new TrustedBuildCellError("build_unavailable", "Build source mode failed");
              }
            },
          );
        }
      }
      await scope.sample("transfer");
    });
    await runStage("pantry-transfer", async () => {
      for (const tarball of input.packageTarballs) {
        await writeVerifiedInput(
          this.sandbox,
          `${passRoot}/pantry/tarballs/${tarball.sha256}.tgz`,
          tarball.bytes,
          tarball.sha256,
          scope,
          (offset, length, signal) =>
            this.pantryRange(tarball.sha256, tarball.bytes, offset, length, signal),
        );
      }
      const manifestsByName = new Map<string, Record<string, unknown>>();
      for (const ingredient of input.packageTarballs) {
        const versions = manifestsByName.get(ingredient.name) ?? {};
        versions[ingredient.version] = trustedBuildRegistryVersion(ingredient);
        manifestsByName.set(ingredient.name, versions);
      }
      const packuments: Record<string, unknown> = {};
      for (const [name, versions] of manifestsByName) {
        packuments[name] = { name, versions, "dist-tags": {} };
      }
      await writeBinary(
        this.sandbox,
        `${passRoot}/pantry/catalog.json`,
        new TextEncoder().encode(
          JSON.stringify({
            packuments,
            tarballs: Object.fromEntries(
              input.packageTarballs.map((tarball) => [
                tarball.sha256,
                `tarballs/${tarball.sha256}.tgz`,
              ]),
            ),
          }),
        ),
        scope,
      );
      await writeBinary(
        this.sandbox,
        `${passRoot}/pantry/server.mjs`,
        new TextEncoder().encode(LOCAL_REGISTRY_SOURCE),
        scope,
      );
      await writeBinary(
        this.sandbox,
        `${passRoot}/pantry/bin-shim-materializer.mjs`,
        new TextEncoder().encode(BIN_SHIM_MATERIALIZER_SOURCE),
        scope,
      );
      await writeBinary(
        this.sandbox,
        `${passRoot}/pantry/collection-aggregator.mjs`,
        new TextEncoder().encode(COLLECTION_AGGREGATOR_SOURCE),
        scope,
      );
      await scope.sample("transfer");
    });
    const resourceMapPath = `${passRoot}/captured/resources.json`;
    await runStage("resource-transfer", async () => {
      for (const resource of input.capturedResources) {
        await writeVerifiedInput(
          this.sandbox,
          `${passRoot}/captured/${resource.sha256}`,
          resource.bytes,
          resource.sha256,
          scope,
          (offset, length, signal) =>
            this.pantryRange(resource.sha256, resource.bytes, offset, length, signal),
        );
      }
      const resourceMap = new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            input.capturedResources.map((resource) => [
              resource.url,
              {
                path: `${passRoot}/captured/${resource.sha256}`,
                sha256: resource.sha256,
                mediaType: resource.mediaType,
              },
            ]),
          ),
        ),
      );
      await writeBinary(this.sandbox, resourceMapPath, resourceMap, scope);
      await scope.sample("transfer");
    });

    const roots = input.roots.map((root) => `${root.name}@${root.version}`);
    const install = argvToCommandString([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--cache",
      `${passRoot}/cache`,
      "--registry",
      `http://127.0.0.1:${LOCAL_REGISTRY_PORT}`,
      ...roots,
    ]);
    const rebuild = argvToCommandString([
      "npm",
      "rebuild",
      "--offline",
      "--foreground-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      `${passRoot}/cache`,
    ]);
    const binDirectory = `${passRoot}/source/node_modules/.bin`;
    const materializeBins = argvToCommandString([
      "node",
      `${passRoot}/pantry/bin-shim-materializer.mjs`,
      `${passRoot}/source/node_modules`,
    ]);
    const verifyBins = trustedBuildBinVerificationCommand(
      binDirectory,
      input.packageTarballs.flatMap((ingredient) => Object.keys(ingredient.bins)),
    );
    const build = argvToCommandString(input.request.input.buildCommand);
    const stagePath = `${passRoot}/stage`;
    const pipeline = [
      "set -eu",
      `cd ${argvToCommandString([`${passRoot}/source`])}`,
      `printf install > ${argvToCommandString([stagePath])}`,
      install,
      `printf bin-materialization > ${argvToCommandString([stagePath])}`,
      materializeBins,
      verifyBins,
      `printf rebuild > ${argvToCommandString([stagePath])}`,
      rebuild,
      `printf post-rebuild-bin-materialization > ${argvToCommandString([stagePath])}`,
      materializeBins,
      verifyBins,
      "rm -f node_modules/.package-lock.json",
      `printf build-command > ${argvToCommandString([stagePath])}`,
      build,
      `printf post-build-bin-materialization > ${argvToCommandString([stagePath])}`,
      materializeBins,
      verifyBins,
    ].join("; ");
    let resolvedNpmExecutable: string | null = null;
    await runStage("toolchain-resolve", async () => {
      resolvedNpmExecutable = await consumeTrustedBuildRpcResult(
        scope,
        this.sandbox.exec(argvToCommandString(["sh", "-c", "command -v npm || true"]), {
          timeout: 10_000,
        }),
        (resolution) => {
          if (!resolution.success) {
            throw new TrustedBuildCellError(
              "build_unavailable",
              "Build toolchain resolution failed",
              "toolchain-resolve",
              commandDiagnostics(resolution, null),
            );
          }
          const candidate = resolution.stdout.trim();
          return candidate === "" ? null : sanitizeBuildDiagnosticText(candidate, 2_048);
        },
      );
    });
    const registry = scope.trackRpc(
      await runStage("registry-start", () =>
        this.sandbox.startProcess(argvToCommandString(["node", `${passRoot}/pantry/server.mjs`]), {
          cwd: `${passRoot}/pantry`,
          env: {
            NABUFLOW_PANTRY_ROOT: `${passRoot}/pantry`,
            NABUFLOW_PANTRY_PORT: String(LOCAL_REGISTRY_PORT),
          },
          processId: `pantry-registry-${pass}`,
          autoCleanup: false,
        }),
      ),
    );
    try {
      await runStage("registry-ready", () =>
        consumeTrustedBuildRpcResult(
          scope,
          registry.waitForPort(LOCAL_REGISTRY_PORT, { mode: "tcp", timeout: 15_000 }),
          () => undefined,
        ),
      );
      await recordStage("install", "started");
      let executed: Awaited<ReturnType<TrustedBuildSandbox["exec"]>> | null = null;
      try {
        executed = scope.trackRpc(
          await this.sandbox.exec(trustedBuildExecutionCommand(pipeline, resourceMapPath), {
            timeout: BUILD_TIMEOUT_MS + 30_000,
          }),
        );
      } catch (error) {
        const stage = await readBuildStage(this.sandbox, stagePath, "install", scope);
        await recordPipelineFailure(stage, recordStage);
        const interrupted = error instanceof Error && error.name === "OperationInterruptedError";
        throw new TrustedBuildCellError(
          interrupted ? "build_timeout" : "build_unavailable",
          interrupted
            ? `Build ${stage} stage was interrupted at its execution boundary`
            : `Build ${stage} stage became unavailable`,
          stage,
        );
      }
      try {
        if (!executed.success) {
          const timedOut = executed.exitCode === 124 || executed.exitCode === 137;
          const stage = await readBuildStage(this.sandbox, stagePath, "install", scope);
          await recordPipelineFailure(stage, recordStage);
          throw new TrustedBuildCellError(
            timedOut ? "build_timeout" : "build_failed",
            timedOut
              ? `Build ${stage} stage exceeded its execution limit`
              : `Build ${stage} stage failed`,
            stage,
            commandDiagnostics(executed, resolvedNpmExecutable),
          );
        }
      } finally {
        scope.disposeRpc(executed);
      }
      await recordStage("install", "succeeded");
      await recordStage("bin-materialization", "succeeded");
      await recordStage("rebuild", "succeeded");
      await recordStage("post-rebuild-bin-materialization", "succeeded");
      await recordStage("build-command", "succeeded");
      await recordStage("post-build-bin-materialization", "succeeded");
      await scope.sample("install");
      await scope.sample("rebuild");
      await scope.sample("build");
    } finally {
      try {
        await consumeTrustedBuildRpcResult(scope, registry.kill(), () => undefined);
      } catch {
        // Best-effort process cleanup must never replace the typed build result. The cell-level
        // destroy boundary below remains authoritative and kills every residual process.
      }
      scope.disposeRpc(registry);
    }
    const appRoot = `${passRoot}/source/${input.request.output.appDirectory}`;
    const dependencyRoot = `${passRoot}/source/node_modules`;
    const aggregatorPath = `${passRoot}/pantry/collection-aggregator.mjs`;
    const [app, dependencies] = await runStage("output-collection", () =>
      Promise.all([
        collectFiles(
          this.sandbox,
          this.bucket,
          scope,
          appRoot,
          aggregatorPath,
          `${passRoot}/collection/app`,
          "app",
          pass,
          input.request.input.buildId,
          input.attempt,
          input.shelfContentSha256,
          async (progress) => {
            await onCollectionProgress?.(progress);
            await scope.sample("collection", progress.peakBufferedBytes);
          },
        ),
        collectFiles(
          this.sandbox,
          this.bucket,
          scope,
          dependencyRoot,
          aggregatorPath,
          `${passRoot}/collection/dependencies`,
          "dependencies",
          pass,
          input.request.input.buildId,
          input.attempt,
          input.shelfContentSha256,
          async (progress) => {
            await onCollectionProgress?.(progress);
            await scope.sample("collection", progress.peakBufferedBytes);
          },
        ),
      ]),
    );
    const processes = scope.trackRpc(await this.sandbox.listProcesses());
    const processPeak = processes.length;
    for (const process of processes) scope.disposeRpc(process);
    scope.disposeRpc(processes);
    return {
      app,
      dependencies,
      lifecycleScriptsExecuted: input.packageTarballs.filter(
        (ingredient) => ingredient.lifecycleScripts === "isolated-passed",
      ).length,
      processPeak,
      elapsedMs: Date.now() - started,
    };
  }

  async destroy(): Promise<void> {
    try {
      await destroyFreshBuildSandbox(this.sandbox);
    } finally {
      await this.scope?.close();
      this.scope = null;
    }
  }
}
