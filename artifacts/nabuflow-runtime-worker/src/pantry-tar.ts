import { canonicalPantryJson, sha256Hex } from "@workspace/tenant-runtime-contracts";
import { PantryIngestError } from "./pantry-registry-client";

const TAR_BLOCK = 512;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 10_000;

export interface NormalizedTarEntry {
  path: string;
  mode: number;
  bytes: number;
  sha256: string;
}

export interface VerifiedTarball {
  normalizedManifest: Uint8Array;
  entries: NormalizedTarEntry[];
  unpackedBytes: number;
}

function ascii(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.slice(0, end));
}

function parseOctal(bytes: Uint8Array): number {
  const value = ascii(bytes).trim().replace(/\0/gu, "");
  if (!/^[0-7]*$/u.test(value))
    throw new PantryIngestError("integrity_mismatch", "Package archive metadata was invalid");
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function validateHeaderChecksum(header: Uint8Array): void {
  const expected = parseOctal(header.slice(148, 156));
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected)
    throw new PantryIngestError("integrity_mismatch", "Package archive header checksum failed");
}

function safePathParts(input: string): string[] | null {
  if (
    input.includes("\\") ||
    input.includes("\0") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/u.test(input)
  )
    return null;
  const withoutTrailingSlash = input.endsWith("/") ? input.slice(0, -1) : input;
  const parts = withoutTrailingSlash.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    withoutTrailingSlash.length > 1_024
  ) {
    return null;
  }
  return parts;
}

function parsePax(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0)
      throw new PantryIngestError("integrity_mismatch", "Package archive PAX record was invalid");
    const length = Number(text.slice(offset, space));
    const record = text.slice(space + 1, offset + length);
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      offset + length > text.length ||
      !record.endsWith("\n")
    ) {
      throw new PantryIngestError("integrity_mismatch", "Package archive PAX record was invalid");
    }
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1, -1);
    offset += length;
  }
  return result;
}

async function gunzipCapped(bytes: Uint8Array): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([new Uint8Array(bytes).buffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
  } catch {
    throw new PantryIngestError("integrity_mismatch", "Package archive was not valid gzip data");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_UNPACKED_BYTES) {
        await reader.cancel();
        throw new PantryIngestError(
          "stocking_size_limit",
          "Package archive exceeded its unpacked size limit",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof PantryIngestError) throw error;
    throw new PantryIngestError("integrity_mismatch", "Package archive decompression failed");
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function inspectNpmTarball(bytes: Uint8Array): Promise<VerifiedTarball> {
  const tar = await gunzipCapped(bytes);
  const entries: NormalizedTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let nextPax: Record<string, string> = {};
  let nextLongPath: string | null = null;
  let rootDirectory: string | null = null;
  let zeroBlocks = 0;
  while (offset + TAR_BLOCK <= tar.byteLength) {
    const header = tar.slice(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    validateHeaderChecksum(header);
    const size = parseOctal(header.slice(124, 136));
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_FILE_BYTES ||
      offset + size > tar.byteLength
    ) {
      throw new PantryIngestError(
        "stocking_size_limit",
        "Package archive entry exceeded its size limit",
      );
    }
    const type = String.fromCharCode(header[156] || 48);
    const prefix = ascii(header.slice(345, 500));
    const headerName = ascii(header.slice(0, 100));
    const candidate =
      nextPax.path ?? nextLongPath ?? (prefix === "" ? headerName : `${prefix}/${headerName}`);
    const data = tar.slice(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === "x") {
      nextPax = parsePax(data);
      nextLongPath = null;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextLongPath = ascii(data);
      nextPax = {};
      continue;
    }
    const parts = safePathParts(candidate);
    nextPax = {};
    nextLongPath = null;
    if (parts === null) {
      throw new PantryIngestError("integrity_mismatch", "Package archive contained an unsafe path");
    }
    rootDirectory ??= parts[0];
    if (parts[0] !== rootDirectory) {
      throw new PantryIngestError("integrity_mismatch", "Package archive contained multiple roots");
    }
    const path = parts.slice(1).join("/");
    if (type === "5") continue;
    if (type !== "0" && type !== "\0") {
      throw new PantryIngestError(
        "integrity_mismatch",
        "Package archive contained a forbidden entry type",
      );
    }
    if (path === "" || seen.has(path)) {
      throw new PantryIngestError("integrity_mismatch", "Package archive contained an unsafe path");
    }
    seen.add(path);
    entries.push({
      path,
      mode: parseOctal(header.slice(100, 108)) & 0o777,
      bytes: size,
      sha256: await sha256Hex(data),
    });
    if (entries.length > MAX_FILES)
      throw new PantryIngestError(
        "stocking_size_limit",
        "Package archive exceeded its file-count limit",
      );
  }
  if (entries.length === 0 || zeroBlocks < 2) {
    throw new PantryIngestError("integrity_mismatch", "Package archive was incomplete");
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const normalizedManifest = new TextEncoder().encode(
    canonicalPantryJson({ format: "nabu-pantry-normalized-package/v1", entries }),
  );
  return {
    normalizedManifest,
    entries,
    unpackedBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  };
}
