import {
  canonicalJson,
  compareUtf8,
  sha256Hex,
  validateRuntimeArtifactPath,
} from "@workspace/tenant-runtime-contracts";

export const RUNTIME_MATERIALIZATION_FORMAT = "nabu-runtime-materialization/v1" as const;
export const RUNTIME_MATERIALIZATION_ROOT = "/workspace/.nabuflow/materializations";
export const RUNTIME_RELEASE_ROOT = "/workspace/.nabuflow/releases";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PAYLOADS = 33;
const MAX_FILES = 25_000;
const MAX_BYTES = 512 * 1024 * 1024;

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
  /** Staging-only fault injection; never emitted without the staging Worker guard. */
  stagingAbortAfterFiles?: number;
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
    ["canonicalManifest", "manifestSha256", "stagingAbortAfterFiles"],
    "materialization request",
    true,
  );
  assertSha256(request.manifestSha256, "materialization manifest hash");
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

export const RUNTIME_MATERIALIZER_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = process.argv[2];
const stageRoot = process.argv[3];
const releaseRoot = process.argv[4];
const stagingAbortAfterFiles = Number(process.argv[5] || "0");
const SHA = /^[0-9a-f]{64}$/;
const safePath = (value) => {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return false;
  if (Buffer.byteLength(value, "utf8") > 1000 || value.startsWith("/") || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)) return false;
  if ([...value].some((character) => { const code = character.charCodeAt(0); return code <= 0x1f || code === 0x7f; })) return false;
  const parts = value.split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..") && parts[0] !== ".nabuflow";
};
const fail = (message) => { throw new Error(message); };
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.format !== "nabu-runtime-materialization/v1" || !SHA.test(manifest.sealedArtifactSha256)) fail("invalid manifest");
if (!Array.isArray(manifest.payloads) || !Array.isArray(manifest.files)) fail("invalid manifest entries");
const expectedReleaseRoot = "/workspace/.nabuflow/releases/" + manifest.sealedArtifactSha256;
if (releaseRoot !== expectedReleaseRoot) fail("invalid release binding");
const temporaryReleaseRoot = releaseRoot + ".materializing";
const appRoot = path.join(temporaryReleaseRoot, "app");
let writtenFiles = 0;
let writtenBytes = 0;
try {
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
  for (const file of manifest.files) {
    const target = path.resolve(appRoot, file.path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size !== file.size || (stat.mode & 0o777) !== file.mode) fail("materialized file posture mismatch");
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
  await writeFile(path.join(temporaryReleaseRoot, "seal.json"), JSON.stringify(manifest.seal), { mode: 0o600, flag: "wx" });
  await rm(releaseRoot, { recursive: true, force: true });
  await rename(temporaryReleaseRoot, releaseRoot);
  process.stdout.write(JSON.stringify({ ok: true, filesWritten: writtenFiles, bytesWritten: writtenBytes }));
} catch (error) {
  await rm(temporaryReleaseRoot, { recursive: true, force: true });
  throw error;
}
`;
