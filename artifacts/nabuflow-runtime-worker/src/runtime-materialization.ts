import {
  canonicalJson,
  compareUtf8,
  DURABLE_OPERATION_PROVIDER_BOUND_MS,
  sha256Hex,
  validateRuntimeArtifactPath,
} from "@workspace/tenant-runtime-contracts";

export const RUNTIME_MATERIALIZATION_FORMAT = "nabu-runtime-materialization/v1" as const;
export const RUNTIME_MATERIALIZATION_ROOT = "/workspace/.nabuflow/materializations";
export const RUNTIME_RELEASE_ROOT = "/workspace/.nabuflow/releases";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PAYLOADS = 33;
const MAX_FILES = 25_000;
export const RUNTIME_RELEASE_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_BYTES = RUNTIME_RELEASE_MAX_ARTIFACT_BYTES;

/**
 * A basic Sandbox has 4 GiB of writable disk and one sealed release can be 512 MiB.
 * Retaining the current release plus one rollback release caps completed release bytes
 * at 1 GiB while preserving the only rollback signal the runtime can prove locally.
 */
export const RUNTIME_RELEASE_RETENTION_COUNT = 2;

/**
 * Materialization has a five-minute provider bound. A second full bound keeps cleanup
 * away from any concurrently finishing attempt while still reclaiming crash leftovers.
 */
export const RUNTIME_RELEASE_STALE_GRACE_MS = 2 * DURABLE_OPERATION_PROVIDER_BOUND_MS;
export const RUNTIME_MATERIALIZATION_LOCK_WAIT_MS = 30_000;
const MATERIALIZATION_LEASE_PATTERN = /^[0-9a-f]{32}$/u;

export interface RuntimeMaterializationPayload {
  index: number;
  contentSha256: string;
  size: number;
}

export interface RuntimeMaterializationFile {
  path: string;
  mode: 420 | 493;
  payloadIndex: number;
  offset: number;
  size: number;
  sha256: string;
}

export interface RuntimeMaterializationSeal {
  format?: "nabu-artifact-layers/v1";
  contentSha256: string;
  sealedArtifactSha256: string;
  manifestRevision: string;
  finalMergedReleaseSha256?: string;
  layers?: string[];
}

export interface RuntimeMaterializationManifest {
  format: typeof RUNTIME_MATERIALIZATION_FORMAT;
  sealedArtifactSha256: string;
  payloads: RuntimeMaterializationPayload[];
  files: RuntimeMaterializationFile[];
  seal: RuntimeMaterializationSeal;
}

export interface RuntimeMaterializationRequest {
  canonicalManifest: string;
  manifestSha256: string;
  /** Attempt-scoped owner for the shared content-addressed staging directory. */
  stageLeaseId?: string;
  /** Previously selected release, when runtime state can identify one for rollback. */
  rollbackReleaseSha256?: string;
  /** Staging-only fault injection; never emitted without the staging Worker guard. */
  stagingAbortAfterFiles?: number;
  /** Unit/staging-only post-rename cleanup failure probe. */
  stagingAbortReleaseCleanup?: boolean;
  /** Unit/staging-only same-release swap-boundary failure probe. */
  stagingAbortBeforeReleaseSwap?: boolean;
  /** Unit-only lock contention probe; never emitted by production flows. */
  stagingHoldLockMs?: number;
}

export function runtimeMaterializationStageRoot(sealedArtifactSha256: string): string {
  assertSha256(sealedArtifactSha256, "sealed artifact hash");
  return `${RUNTIME_MATERIALIZATION_ROOT}/${sealedArtifactSha256}`;
}

export function runtimeMaterializationPayloadPath(
  sealedArtifactSha256: string,
  payload: RuntimeMaterializationPayload,
): string {
  validateRuntimeMaterializationPayload(payload);
  return `${runtimeMaterializationStageRoot(sealedArtifactSha256)}/${String(payload.index).padStart(2, "0")}-${payload.contentSha256}.payload`;
}

export async function sealRuntimeMaterializationManifest(
  manifest: RuntimeMaterializationManifest,
): Promise<RuntimeMaterializationRequest> {
  const canonicalManifest = canonicalJson(
    validateRuntimeMaterializationManifest({
      ...manifest,
      payloads: [...manifest.payloads].sort((left, right) => left.index - right.index),
      files: [...manifest.files].sort((left, right) => compareUtf8(left.path, right.path)),
    }),
  );
  return {
    canonicalManifest,
    manifestSha256: await sha256Hex(canonicalManifest),
  };
}

export function parseRuntimeMaterializationRequest(
  request: RuntimeMaterializationRequest,
): RuntimeMaterializationManifest {
  assertExactKeys(
    request as unknown as Record<string, unknown>,
    [
      "canonicalManifest",
      "manifestSha256",
      "rollbackReleaseSha256",
      "stageLeaseId",
      "stagingAbortAfterFiles",
      "stagingAbortBeforeReleaseSwap",
      "stagingAbortReleaseCleanup",
      "stagingHoldLockMs",
    ],
    "materialization request",
    true,
  );
  assertSha256(request.manifestSha256, "materialization manifest hash");
  if (request.rollbackReleaseSha256 !== undefined) {
    assertSha256(request.rollbackReleaseSha256, "rollback release hash");
  }
  if (
    request.stageLeaseId !== undefined &&
    (typeof request.stageLeaseId !== "string" ||
      !MATERIALIZATION_LEASE_PATTERN.test(request.stageLeaseId))
  ) {
    throw new Error("Runtime materialization stage lease is invalid");
  }
  if (typeof request.canonicalManifest !== "string" || request.canonicalManifest.length === 0) {
    throw new Error("Runtime materialization manifest is unavailable");
  }
  if (
    request.stagingAbortAfterFiles !== undefined &&
    (!Number.isSafeInteger(request.stagingAbortAfterFiles) ||
      request.stagingAbortAfterFiles < 1 ||
      request.stagingAbortAfterFiles > MAX_FILES)
  ) {
    throw new Error("Runtime materialization staging probe is invalid");
  }
  if (
    request.stagingAbortReleaseCleanup !== undefined &&
    typeof request.stagingAbortReleaseCleanup !== "boolean"
  ) {
    throw new Error("Runtime release cleanup staging probe is invalid");
  }
  if (
    request.stagingAbortBeforeReleaseSwap !== undefined &&
    typeof request.stagingAbortBeforeReleaseSwap !== "boolean"
  ) {
    throw new Error("Runtime release swap staging probe is invalid");
  }
  if (
    request.stagingHoldLockMs !== undefined &&
    (!Number.isSafeInteger(request.stagingHoldLockMs) ||
      request.stagingHoldLockMs < 0 ||
      request.stagingHoldLockMs > 5_000)
  ) {
    throw new Error("Runtime materialization lock staging probe is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(request.canonicalManifest);
  } catch {
    throw new Error("Runtime materialization manifest is malformed");
  }
  const manifest = validateRuntimeMaterializationManifest(decoded);
  if (canonicalJson(manifest) !== request.canonicalManifest) {
    throw new Error("Runtime materialization manifest is not canonical");
  }
  return manifest;
}

export async function verifyRuntimeMaterializationRequest(
  request: RuntimeMaterializationRequest,
): Promise<RuntimeMaterializationManifest> {
  const manifest = parseRuntimeMaterializationRequest(request);
  if ((await sha256Hex(request.canonicalManifest)) !== request.manifestSha256) {
    throw new Error("Runtime materialization manifest failed integrity verification");
  }
  return manifest;
}

export function validateRuntimeMaterializationManifest(
  input: unknown,
): RuntimeMaterializationManifest {
  assertRecord(input, "materialization manifest");
  assertExactKeys(
    input,
    ["files", "format", "payloads", "seal", "sealedArtifactSha256"],
    "materialization manifest",
  );
  if (input.format !== RUNTIME_MATERIALIZATION_FORMAT) {
    throw new Error("Runtime materialization format is unsupported");
  }
  assertSha256(input.sealedArtifactSha256, "sealed artifact hash");
  if (
    !Array.isArray(input.payloads) ||
    input.payloads.length === 0 ||
    input.payloads.length > MAX_PAYLOADS
  ) {
    throw new Error("Runtime materialization payload count is invalid");
  }
  if (!Array.isArray(input.files) || input.files.length > MAX_FILES) {
    throw new Error("Runtime materialization file count is invalid");
  }
  const payloads = input.payloads.map((payload) => validateRuntimeMaterializationPayload(payload));
  for (let index = 0; index < payloads.length; index += 1) {
    if (payloads[index].index !== index) {
      throw new Error("Runtime materialization payload indexes are not canonical");
    }
  }
  const payloadByIndex = new Map(payloads.map((payload) => [payload.index, payload]));
  const files = input.files.map((file) => validateRuntimeMaterializationFile(file, payloadByIndex));
  let previousPath: string | null = null;
  const filesByPayload = new Map<number, RuntimeMaterializationFile[]>();
  for (const file of files) {
    if (previousPath !== null && compareUtf8(previousPath, file.path) >= 0) {
      throw new Error("Runtime materialization paths are not unique and canonical");
    }
    previousPath = file.path;
    const bucket = filesByPayload.get(file.payloadIndex) ?? [];
    bucket.push(file);
    filesByPayload.set(file.payloadIndex, bucket);
  }
  let totalBytes = 0;
  for (const payload of payloads) {
    const payloadFiles = (filesByPayload.get(payload.index) ?? []).sort(
      (left, right) => left.offset - right.offset,
    );
    let offset = 0;
    for (const file of payloadFiles) {
      if (file.offset !== offset) {
        throw new Error("Runtime materialization payload files are not contiguous");
      }
      offset += file.size;
    }
    if (offset !== payload.size) {
      throw new Error("Runtime materialization payload size does not match its files");
    }
    totalBytes += payload.size;
  }
  if (totalBytes > MAX_BYTES) throw new Error("Runtime materialization exceeds the byte limit");
  const seal = validateRuntimeMaterializationSeal(input.seal, input.sealedArtifactSha256);
  return {
    format: RUNTIME_MATERIALIZATION_FORMAT,
    sealedArtifactSha256: input.sealedArtifactSha256,
    payloads,
    files,
    seal,
  };
}

function validateRuntimeMaterializationPayload(input: unknown): RuntimeMaterializationPayload {
  assertRecord(input, "materialization payload");
  assertExactKeys(input, ["contentSha256", "index", "size"], "materialization payload");
  if (
    !Number.isSafeInteger(input.index) ||
    (input.index as number) < 0 ||
    (input.index as number) >= MAX_PAYLOADS
  ) {
    throw new Error("Runtime materialization payload index is invalid");
  }
  assertSha256(input.contentSha256, "materialization payload hash");
  if (
    !Number.isSafeInteger(input.size) ||
    (input.size as number) < 0 ||
    (input.size as number) > MAX_BYTES
  ) {
    throw new Error("Runtime materialization payload size is invalid");
  }
  return {
    index: input.index as number,
    contentSha256: input.contentSha256,
    size: input.size as number,
  };
}

function validateRuntimeMaterializationFile(
  input: unknown,
  payloads: ReadonlyMap<number, RuntimeMaterializationPayload>,
): RuntimeMaterializationFile {
  assertRecord(input, "materialization file");
  assertExactKeys(
    input,
    ["mode", "offset", "path", "payloadIndex", "sha256", "size"],
    "materialization file",
  );
  if (typeof input.path !== "string" || validateRuntimeArtifactPath(input.path) === null) {
    throw new Error("Runtime materialization file path is invalid");
  }
  if (input.mode !== 0o644 && input.mode !== 0o755) {
    throw new Error("Runtime materialization file mode is invalid");
  }
  if (!Number.isSafeInteger(input.payloadIndex) || !payloads.has(input.payloadIndex as number)) {
    throw new Error("Runtime materialization file payload is invalid");
  }
  if (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0) {
    throw new Error("Runtime materialization file offset is invalid");
  }
  if (!Number.isSafeInteger(input.size) || (input.size as number) < 0) {
    throw new Error("Runtime materialization file size is invalid");
  }
  const payload = payloads.get(input.payloadIndex as number)!;
  if ((input.offset as number) + (input.size as number) > payload.size) {
    throw new Error("Runtime materialization file exceeds its payload");
  }
  assertSha256(input.sha256, "materialization file hash");
  return {
    path: input.path,
    mode: input.mode,
    payloadIndex: input.payloadIndex as number,
    offset: input.offset as number,
    size: input.size as number,
    sha256: input.sha256,
  };
}

function validateRuntimeMaterializationSeal(
  input: unknown,
  sealedArtifactSha256: string,
): RuntimeMaterializationSeal {
  assertRecord(input, "materialization seal");
  const allowed = [
    "contentSha256",
    "finalMergedReleaseSha256",
    "format",
    "layers",
    "manifestRevision",
    "sealedArtifactSha256",
  ];
  assertExactKeys(input, allowed, "materialization seal", true);
  assertSha256(input.contentSha256, "materialization content hash");
  if (input.sealedArtifactSha256 !== sealedArtifactSha256) {
    throw new Error("Runtime materialization seal binding is invalid");
  }
  if (
    typeof input.manifestRevision !== "string" ||
    input.manifestRevision.length === 0 ||
    input.manifestRevision.length > 200
  ) {
    throw new Error("Runtime materialization manifest revision is invalid");
  }
  if (input.format !== undefined && input.format !== "nabu-artifact-layers/v1") {
    throw new Error("Runtime materialization seal format is invalid");
  }
  if (input.finalMergedReleaseSha256 !== undefined) {
    assertSha256(input.finalMergedReleaseSha256, "merged release hash");
  }
  if (input.layers !== undefined) {
    if (!Array.isArray(input.layers) || input.layers.length > 32) {
      throw new Error("Runtime materialization layer hashes are invalid");
    }
    for (const layer of input.layers) assertSha256(layer, "materialization layer hash");
  }
  return {
    ...(input.format === undefined ? {} : { format: input.format }),
    contentSha256: input.contentSha256,
    sealedArtifactSha256: input.sealedArtifactSha256 as string,
    manifestRevision: input.manifestRevision,
    ...(input.finalMergedReleaseSha256 === undefined
      ? {}
      : { finalMergedReleaseSha256: input.finalMergedReleaseSha256 }),
    ...(input.layers === undefined ? {} : { layers: [...input.layers] as string[] }),
  };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Runtime ${label} is malformed`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
  optional = false,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Runtime ${label} contains unsupported fields`);
  }
  if (!optional && keys.some((key) => !(key in value))) {
    throw new Error(`Runtime ${label} is incomplete`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Runtime ${label} is invalid`);
  }
}

export function runtimeMaterializationLeasePath(
  sealedArtifactSha256: string,
  stageLeaseId: string,
): string {
  assertSha256(sealedArtifactSha256, "sealed artifact hash");
  if (!MATERIALIZATION_LEASE_PATTERN.test(stageLeaseId)) {
    throw new Error("Runtime materialization stage lease is invalid");
  }
  return `${runtimeMaterializationStageRoot(sealedArtifactSha256)}/.lease-${stageLeaseId}`;
}

/**
 * Register an attempt under the same filesystem lock used by release swap and GC.
 * Payload writes are attempt-named and content-addressed, so the lock can be released
 * after registration without allowing a peer to delete or overwrite in-flight bytes.
 */
export const RUNTIME_MATERIALIZATION_PREPARER_SOURCE = String.raw`
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const stageRoot = process.argv[1];
const releaseBaseRoot = process.argv[2];
const stageLeaseId = process.argv[3];
const SHA = /^[0-9a-f]{64}$/;
const LEASE = /^[0-9a-f]{32}$/;
const LOCK_WAIT_MS = ${RUNTIME_MATERIALIZATION_LOCK_WAIT_MS};
const STALE_GRACE_MS = ${RUNTIME_RELEASE_STALE_GRACE_MS};
const materializationBaseRoot = path.dirname(stageRoot);
const expectedStageRoot = "/workspace/.nabuflow/materializations/" + path.basename(stageRoot);
const fail = (message) => { throw new Error(message); };
if (stageRoot !== expectedStageRoot || !SHA.test(path.basename(stageRoot))) fail("invalid stage binding");
if (releaseBaseRoot !== "/workspace/.nabuflow/releases") fail("invalid release base binding");
if (!LEASE.test(stageLeaseId)) fail("invalid stage lease");
const lockRoot = path.join(releaseBaseRoot, ".runtime-materialization.lock");
const ownerPath = path.join(lockRoot, "owner");
const owner = stageLeaseId + "-prepare-" + process.pid;
const acquireLock = async () => {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockRoot, { mode: 0o700 });
      try {
        await writeFile(ownerPath, owner, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(lockRoot, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await lstat(lockRoot).catch(() => null);
      if (stat !== null && Date.now() - stat.mtimeMs > STALE_GRACE_MS) {
        const staleRoot = path.join(materializationBaseRoot, ".stale-lock-" + owner);
        try {
          await rename(lockRoot, staleRoot);
          await rm(staleRoot, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
      if (Date.now() >= deadline) fail("runtime materialization filesystem is busy");
      await delay(25);
    }
  }
};
const releaseLock = async () => {
  const actualOwner = await readFile(ownerPath, "utf8").catch(() => "");
  if (actualOwner === owner) await rm(lockRoot, { recursive: true, force: false });
};
await mkdir(releaseBaseRoot, { recursive: true });
await acquireLock();
try {
  await mkdir(stageRoot, { recursive: true });
  const leasePath = path.join(stageRoot, ".lease-" + stageLeaseId);
  try {
    await writeFile(leasePath, stageLeaseId, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST" || await readFile(leasePath, "utf8") !== stageLeaseId) throw error;
  }
} finally {
  await releaseLock();
}
`;

export const RUNTIME_MATERIALIZER_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const manifestPath = process.argv[2];
const stageRoot = process.argv[3];
const releaseRoot = process.argv[4];
const stagingAbortAfterFiles = Number(process.argv[5] || "0");
const rollbackReleaseSha256 = process.argv[6] || "";
const stagingAbortReleaseCleanup = process.argv[7] === "1";
const stagingAbortBeforeReleaseSwap = process.argv[8] === "1";
const stageLeaseId = process.argv[9] || "";
const stagingHoldLockMs = Number(process.argv[10] || "0");
const SHA = /^[0-9a-f]{64}$/;
const LEASE = /^[0-9a-f]{32}$/;
const MANAGED_RELEASE = /^[0-9a-f]{64}(?:\.materializing)?$/;
const RELEASE_RETENTION_COUNT = ${RUNTIME_RELEASE_RETENTION_COUNT};
const STALE_GRACE_MS = ${RUNTIME_RELEASE_STALE_GRACE_MS};
const LOCK_WAIT_MS = ${RUNTIME_MATERIALIZATION_LOCK_WAIT_MS};
const safePath = (value) => {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return false;
  if (Buffer.byteLength(value, "utf8") > 1000 || value.startsWith("/") || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)) return false;
  if ([...value].some((character) => { const code = character.charCodeAt(0); return code <= 0x1f || code === 0x7f; })) return false;
  const parts = value.split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..") && parts[0] !== ".nabuflow";
};
const fail = (message) => { throw new Error(message); };
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.format !== "nabu-runtime-materialization/v1" || !SHA.test(manifest.sealedArtifactSha256)) fail("invalid manifest");
if (!Array.isArray(manifest.payloads) || !Array.isArray(manifest.files)) fail("invalid manifest entries");
const expectedReleaseRoot = "/workspace/.nabuflow/releases/" + manifest.sealedArtifactSha256;
if (releaseRoot !== expectedReleaseRoot) fail("invalid release binding");
if (rollbackReleaseSha256 !== "" && !SHA.test(rollbackReleaseSha256)) fail("invalid rollback release");
if (!LEASE.test(stageLeaseId)) fail("invalid stage lease");
if (!Number.isSafeInteger(stagingHoldLockMs) || stagingHoldLockMs < 0 || stagingHoldLockMs > 5_000) fail("invalid lock hold probe");
const temporaryReleaseRoot = releaseRoot + ".materializing";
const appRoot = path.join(temporaryReleaseRoot, "app");
const releaseBaseRoot = path.dirname(releaseRoot);
const materializationBaseRoot = path.dirname(stageRoot);
const releaseStatePath = path.join(releaseBaseRoot, ".release-state.json");
const nextReleaseStatePath = path.join(releaseBaseRoot, ".release-state.next.json");
const lockRoot = path.join(releaseBaseRoot, ".runtime-materialization.lock");
const lockOwnerPath = path.join(lockRoot, "owner");
const lockOwner = stageLeaseId + "-materialize-" + process.pid;
const acquireLock = async () => {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockRoot, { mode: 0o700 });
      try {
        await writeFile(lockOwnerPath, lockOwner, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(lockRoot, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await lstat(lockRoot).catch(() => null);
      if (stat !== null && Date.now() - stat.mtimeMs > STALE_GRACE_MS) {
        const staleRoot = path.join(materializationBaseRoot, ".stale-lock-" + lockOwner);
        try {
          await rename(lockRoot, staleRoot);
          await rm(staleRoot, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
      if (Date.now() >= deadline) fail("runtime materialization filesystem is busy");
      await delay(25);
    }
  }
};
const releaseLock = async () => {
  const actualOwner = await readFile(lockOwnerPath, "utf8").catch(() => "");
  if (actualOwner === lockOwner) await rm(lockRoot, { recursive: true, force: false });
};
let writtenFiles = 0;
let writtenBytes = 0;
let releasesRemoved = 0;
let leftoversRemoved = 0;
const verifyRelease = async (root) => {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("release posture is invalid");
  const releaseAppRoot = path.join(root, "app");
  const actualPaths = [];
  const visit = async (relativeRoot) => {
    const directory = relativeRoot === "" ? releaseAppRoot : path.join(releaseAppRoot, relativeRoot);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name))) {
      if (entry.isSymbolicLink()) fail("release posture is invalid");
      const relative = relativeRoot === "" ? entry.name : relativeRoot + "/" + entry.name;
      if (entry.isDirectory()) {
        await visit(relative);
      } else if (entry.isFile()) {
        actualPaths.push(relative);
      } else {
        fail("release posture is invalid");
      }
    }
  };
  await visit("");
  const expectedPaths = manifest.files.map((file) => file.path).sort(compareUtf8);
  actualPaths.sort(compareUtf8);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) fail("release file set is invalid");
  for (const file of manifest.files) {
    const target = path.resolve(releaseAppRoot, file.path);
    if (!target.startsWith(releaseAppRoot + path.sep)) fail("release path escaped release root");
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || (stat.mode & 0o777) !== file.mode) fail("materialized file posture mismatch");
    const verifier = await open(target, "r");
    const verifierHasher = createHash("sha256");
    try {
      let position = 0;
      while (position < file.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - position));
        const { bytesRead } = await verifier.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) fail("materialized file ended early");
        verifierHasher.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await verifier.close();
    }
    if (verifierHasher.digest("hex") !== file.sha256) fail("post-unpack file hash mismatch");
  }
  let existingSeal;
  try {
    existingSeal = JSON.parse(await readFile(path.join(root, "seal.json"), "utf8"));
  } catch {
    fail("release seal is unavailable");
  }
  if (JSON.stringify(existingSeal) !== JSON.stringify(manifest.seal)) fail("release seal is invalid");
};
await mkdir(releaseBaseRoot, { recursive: true });
await acquireLock();
try {
  const leasePath = path.join(stageRoot, ".lease-" + stageLeaseId);
  if (await readFile(leasePath, "utf8").catch(() => "") !== stageLeaseId) fail("stage lease is unavailable");
  if (stagingHoldLockMs > 0) await delay(stagingHoldLockMs);
  await rm(temporaryReleaseRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });
  for (const payload of manifest.payloads) {
    if (!Number.isSafeInteger(payload.index) || !Number.isSafeInteger(payload.size) || payload.size < 0 || !SHA.test(payload.contentSha256)) fail("invalid payload");
    const payloadPath = path.join(stageRoot, String(payload.index).padStart(2, "0") + "-" + payload.contentSha256 + ".payload");
    const payloadStat = await lstat(payloadPath);
    if (!payloadStat.isFile() || payloadStat.size !== payload.size) fail("invalid payload file");
    const source = await open(payloadPath, "r");
    const aggregateHasher = createHash("sha256");
    try {
      const payloadFiles = manifest.files.filter((file) => file.payloadIndex === payload.index).sort((left, right) => left.offset - right.offset);
      let expectedOffset = 0;
      for (const file of payloadFiles) {
        if (!safePath(file.path) || (file.mode !== 420 && file.mode !== 493) || !SHA.test(file.sha256) || file.offset !== expectedOffset || !Number.isSafeInteger(file.size) || file.size < 0) fail("invalid file entry");
        const target = path.resolve(appRoot, file.path);
        if (!target.startsWith(appRoot + path.sep)) fail("path escaped release root");
        await mkdir(path.dirname(target), { recursive: true });
        const destination = await open(target, "wx", file.mode);
        const fileHasher = createHash("sha256");
        let remaining = file.size;
        let position = file.offset;
        try {
          while (remaining > 0) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
            const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
            if (bytesRead <= 0) fail("payload ended early");
            const chunk = buffer.subarray(0, bytesRead);
            aggregateHasher.update(chunk);
            fileHasher.update(chunk);
            await destination.write(chunk);
            position += bytesRead;
            remaining -= bytesRead;
            writtenBytes += bytesRead;
          }
        } finally {
          await destination.close();
        }
        if (fileHasher.digest("hex") !== file.sha256) fail("file transport hash mismatch");
        await chmod(target, file.mode);
        expectedOffset += file.size;
        writtenFiles += 1;
        if (stagingAbortAfterFiles > 0 && writtenFiles === stagingAbortAfterFiles) fail("staging materializer owner-loss probe");
      }
      if (expectedOffset !== payload.size || aggregateHasher.digest("hex") !== payload.contentSha256) fail("aggregate transport hash mismatch");
    } finally {
      await source.close();
    }
  }
  await writeFile(path.join(temporaryReleaseRoot, "seal.json"), JSON.stringify(manifest.seal), { mode: 0o600, flag: "wx" });
  await verifyRelease(temporaryReleaseRoot);
  let releaseExists = false;
  let releaseCorrupt = false;
  try {
    await verifyRelease(releaseRoot);
    releaseExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") releaseCorrupt = true;
  }
  if (stagingAbortBeforeReleaseSwap) fail("release swap interrupted");
  if (releaseExists) {
    await rm(temporaryReleaseRoot, { recursive: true, force: false });
  } else {
    const displacedReleaseRoot = releaseRoot + ".corrupt-" + stageLeaseId;
    if (releaseCorrupt) {
      await rm(displacedReleaseRoot, { recursive: true, force: true });
      await rename(releaseRoot, displacedReleaseRoot);
    }
    try {
      await rename(temporaryReleaseRoot, releaseRoot);
    } catch (error) {
      if (releaseCorrupt) await rename(displacedReleaseRoot, releaseRoot).catch(() => undefined);
      throw error;
    }
    if (releaseCorrupt) await rm(displacedReleaseRoot, { recursive: true, force: false });
  }
  if (stagingAbortReleaseCleanup) fail("release cleanup failed");

  // Cleanup begins only after the verified release has reached its final content address.
  // First inventory every managed entry; ambiguity fails before a single stale release is removed.
  const releaseEntries = await readdir(releaseBaseRoot, { withFileTypes: true });
  const completeReleases = [];
  const materializingReleases = [];
  for (const entry of releaseEntries) {
    if (entry.name === ".release-state.json" || entry.name === ".release-state.next.json") continue;
    if (!MANAGED_RELEASE.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("release cleanup inventory is ambiguous");
    const entryPath = path.join(releaseBaseRoot, entry.name);
    const stat = await lstat(entryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("release cleanup inventory is ambiguous");
    if (entry.name.endsWith(".materializing")) {
      materializingReleases.push({ name: entry.name, path: entryPath, mtimeMs: stat.mtimeMs });
    } else {
      completeReleases.push({ name: entry.name, path: entryPath });
    }
  }
  if (!completeReleases.some((entry) => entry.name === manifest.sealedArtifactSha256)) {
    fail("current release is unavailable after materialization");
  }

  let releaseState = { currentReleaseSha256: "", rollbackReleaseSha256: "" };
  try {
    const decoded = JSON.parse(await readFile(releaseStatePath, "utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      Object.keys(decoded).sort().join(",") !== "currentReleaseSha256,rollbackReleaseSha256" ||
      !SHA.test(decoded.currentReleaseSha256) ||
      (decoded.rollbackReleaseSha256 !== null && !SHA.test(decoded.rollbackReleaseSha256)) ||
      decoded.rollbackReleaseSha256 === decoded.currentReleaseSha256
    ) {
      fail("release state is invalid");
    }
    releaseState = {
      currentReleaseSha256: decoded.currentReleaseSha256,
      rollbackReleaseSha256: decoded.rollbackReleaseSha256 ?? "",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") fail("release state is unavailable");
  }
  const explicitRollback = rollbackReleaseSha256 === manifest.sealedArtifactSha256 ? "" : rollbackReleaseSha256;
  const priorCurrent = releaseState.currentReleaseSha256 === manifest.sealedArtifactSha256 ? "" : releaseState.currentReleaseSha256;
  const protectedReleases = new Set([manifest.sealedArtifactSha256]);
  const knownRollback =
    priorCurrent ||
    explicitRollback ||
    (releaseState.currentReleaseSha256 === manifest.sealedArtifactSha256
      ? releaseState.rollbackReleaseSha256
      : "");
  if (knownRollback !== "") {
    if (!completeReleases.some((entry) => entry.name === knownRollback)) {
      fail("rollback release is unavailable");
    }
    protectedReleases.add(knownRollback);
  }
  if (protectedReleases.size > RELEASE_RETENTION_COUNT) fail("release retention bound is ambiguous");

  for (const entry of completeReleases
    .filter((candidate) => !protectedReleases.has(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    await rm(entry.path, { recursive: true, force: false });
    releasesRemoved += 1;
  }
  const staleBeforeMs = Date.now() - STALE_GRACE_MS;
  for (const entry of materializingReleases
    .filter((candidate) => candidate.mtimeMs <= staleBeforeMs)
    .sort((left, right) => left.name.localeCompare(right.name))) {
    await rm(entry.path, { recursive: true, force: false });
    leftoversRemoved += 1;
  }
  const stagedEntries = await readdir(materializationBaseRoot, { withFileTypes: true });
  for (const entry of stagedEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!SHA.test(entry.name) || path.join(materializationBaseRoot, entry.name) === stageRoot) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("materialization cleanup inventory is ambiguous");
    const entryPath = path.join(materializationBaseRoot, entry.name);
    const stat = await lstat(entryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("materialization cleanup inventory is ambiguous");
    if (stat.mtimeMs > staleBeforeMs) continue;
    const leaseEntries = await readdir(entryPath, { withFileTypes: true });
    let hasActiveLease = false;
    for (const leaseEntry of leaseEntries.filter((candidate) => candidate.name.startsWith(".lease-"))) {
      if (!leaseEntry.isFile() || leaseEntry.isSymbolicLink() || !LEASE.test(leaseEntry.name.slice(7))) fail("materialization lease inventory is ambiguous");
      const leaseStat = await lstat(path.join(entryPath, leaseEntry.name));
      if (leaseStat.mtimeMs > staleBeforeMs) hasActiveLease = true;
    }
    if (hasActiveLease) continue;
    await rm(entryPath, { recursive: true, force: false });
    leftoversRemoved += 1;
  }

  await rm(nextReleaseStatePath, { force: true });
  await writeFile(
    nextReleaseStatePath,
    JSON.stringify({
      currentReleaseSha256: manifest.sealedArtifactSha256,
      rollbackReleaseSha256: knownRollback === "" ? null : knownRollback,
    }),
    { mode: 0o600, flag: "wx" },
  );
  await rename(nextReleaseStatePath, releaseStatePath);
  await rm(path.join(stageRoot, ".lease-" + stageLeaseId), { force: false });
  const currentStageEntries = await readdir(stageRoot, { withFileTypes: true });
  let peerLeaseActive = false;
  for (const entry of currentStageEntries.filter((candidate) => candidate.name.startsWith(".lease-"))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !LEASE.test(entry.name.slice(7))) fail("materialization lease inventory is ambiguous");
    const stat = await lstat(path.join(stageRoot, entry.name));
    if (stat.mtimeMs > staleBeforeMs) peerLeaseActive = true;
  }
  if (!peerLeaseActive) {
    await rm(stageRoot, { recursive: true, force: false });
    leftoversRemoved += 1;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    filesWritten: writtenFiles,
    bytesWritten: writtenBytes,
    releasesRetained: protectedReleases.size,
    releasesRemoved,
    leftoversRemoved,
  }));
} catch (error) {
  await rm(temporaryReleaseRoot, { recursive: true, force: true });
  await rm(nextReleaseStatePath, { force: true });
  throw error;
} finally {
  await releaseLock();
}
`;
