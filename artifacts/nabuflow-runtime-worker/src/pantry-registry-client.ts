import type { PantryErrorCode } from "@workspace/tenant-runtime-contracts";

export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
// Full packuments are required because immutable shelf records include the exact
// publication timestamp; npm's abbreviated install document intentionally omits `time`.
const PACKUMENT_ACCEPT = "application/json";
const MAX_PACKUMENT_BYTES = 32 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024;
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

export class PantryIngestError extends Error {
  constructor(
    readonly code: PantryErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PantryIngestError";
  }
}

export interface NpmDistSignature {
  keyid: string;
  sig: string;
}

export interface NpmVersionDocument {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  engines: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  scripts: Record<string, string>;
  license?: string;
  deprecated: boolean;
  dist: {
    integrity: string;
    tarball: string;
    fileCount?: number;
    unpackedSize?: number;
    signatures: NpmDistSignature[];
    attestationsUrl?: string;
  };
}

export interface NpmPackument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, NpmVersionDocument>;
  publishTimes: Record<string, string>;
}

export interface NpmAttestationEvidence {
  bytes: Uint8Array;
  structurallyBound: boolean;
}

export type TrustedFetch = (request: Request) => Promise<Response>;

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

function parseVersionDocument(value: unknown): NpmVersionDocument | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const dist = input.dist;
  if (
    typeof input.name !== "string" ||
    typeof input.version !== "string" ||
    typeof dist !== "object" ||
    dist === null ||
    Array.isArray(dist)
  ) {
    return null;
  }
  const rawDist = dist as Record<string, unknown>;
  if (typeof rawDist.integrity !== "string" || typeof rawDist.tarball !== "string") return null;
  const signatures = Array.isArray(rawDist.signatures)
    ? rawDist.signatures.flatMap((signature) => {
        if (typeof signature !== "object" || signature === null || Array.isArray(signature))
          return [];
        const item = signature as Record<string, unknown>;
        return typeof item.keyid === "string" && typeof item.sig === "string"
          ? [{ keyid: item.keyid, sig: item.sig }]
          : [];
      })
    : [];
  const peerDependenciesMeta: Record<string, { optional?: boolean }> = {};
  if (
    typeof input.peerDependenciesMeta === "object" &&
    input.peerDependenciesMeta !== null &&
    !Array.isArray(input.peerDependenciesMeta)
  ) {
    for (const [name, metadata] of Object.entries(input.peerDependenciesMeta)) {
      if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
        peerDependenciesMeta[name] = {
          ...((metadata as { optional?: unknown }).optional === true ? { optional: true } : {}),
        };
      }
    }
  }
  const attestations = rawDist.attestations;
  const attestationsUrl =
    typeof attestations === "object" &&
    attestations !== null &&
    !Array.isArray(attestations) &&
    typeof (attestations as { url?: unknown }).url === "string"
      ? (attestations as { url: string }).url
      : undefined;
  return {
    name: input.name,
    version: input.version,
    dependencies: stringRecord(input.dependencies),
    optionalDependencies: stringRecord(input.optionalDependencies),
    peerDependencies: stringRecord(input.peerDependencies),
    peerDependenciesMeta,
    engines: stringRecord(input.engines),
    os: optionalStringArray(input.os),
    cpu: optionalStringArray(input.cpu),
    libc: optionalStringArray(input.libc),
    scripts: stringRecord(input.scripts),
    ...(typeof input.license === "string" ? { license: input.license } : {}),
    deprecated: typeof input.deprecated === "string" || input.deprecated === true,
    dist: {
      integrity: rawDist.integrity,
      tarball: rawDist.tarball,
      ...(typeof rawDist.fileCount === "number" ? { fileCount: rawDist.fileCount } : {}),
      ...(typeof rawDist.unpackedSize === "number" ? { unpackedSize: rawDist.unpackedSize } : {}),
      signatures,
      ...(attestationsUrl === undefined ? {} : { attestationsUrl }),
    },
  };
}

function parsePackument(value: unknown): NpmPackument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PantryIngestError("upstream_unavailable", "Registry metadata was malformed", true);
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string") {
    throw new PantryIngestError("upstream_unavailable", "Registry metadata was malformed", true);
  }
  const versions: Record<string, NpmVersionDocument> = {};
  if (
    typeof input.versions === "object" &&
    input.versions !== null &&
    !Array.isArray(input.versions)
  ) {
    for (const [version, document] of Object.entries(input.versions)) {
      const parsed = parseVersionDocument(document);
      if (parsed !== null && parsed.version === version && parsed.name === input.name)
        versions[version] = parsed;
    }
  }
  const publishTimes: Record<string, string> = {};
  if (typeof input.time === "object" && input.time !== null && !Array.isArray(input.time)) {
    for (const [version, time] of Object.entries(input.time)) {
      if (typeof time === "string") publishTimes[version] = time;
    }
  }
  return { name: input.name, distTags: stringRecord(input["dist-tags"]), versions, publishTimes };
}

function assertOfficialRegistryUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PantryIngestError("upstream_unavailable", "Registry returned an invalid URL", true);
  }
  if (
    url.origin !== NPM_REGISTRY_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new PantryIngestError(
      "upstream_unavailable",
      "Registry egress target was rejected",
      false,
    );
  }
  return url;
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PantryIngestError("stocking_size_limit", "Registry response exceeded its size limit");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PantryIngestError(
        "stocking_size_limit",
        "Registry response exceeded its size limit",
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseError(response: Response): PantryIngestError {
  if (response.status === 404)
    return new PantryIngestError("package_not_found", "Package was not found");
  return new PantryIngestError(
    "upstream_unavailable",
    "Registry request failed",
    response.status >= 500,
  );
}

export class NpmRegistryClient {
  readonly fetchCounts = new Map<string, number>();

  constructor(private readonly trustedFetch: TrustedFetch = (request) => fetch(request)) {}

  async fetchPackument(name: string): Promise<{ packument: NpmPackument; bytes: Uint8Array }> {
    const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}`;
    const bytes = await this.fetchBytes(url, MAX_PACKUMENT_BYTES, {
      accept: PACKUMENT_ACCEPT,
    });
    try {
      return {
        packument: parsePackument(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ),
        bytes,
      };
    } catch (error) {
      if (error instanceof PantryIngestError) throw error;
      throw new PantryIngestError("upstream_unavailable", "Registry metadata was malformed", true);
    }
  }

  async fetchTarball(url: string): Promise<Uint8Array> {
    return this.fetchBytes(url, MAX_TARBALL_BYTES, { accept: "application/octet-stream" });
  }

  async fetchAttestations(
    url: string,
    name: string,
    version: string,
    sha512Hex: string,
  ): Promise<NpmAttestationEvidence> {
    const bytes = await this.fetchBytes(url, MAX_ATTESTATION_BYTES, { accept: "application/json" });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new PantryIngestError("provenance_rejected", "Published provenance was malformed");
    }
    const input = value as { attestations?: unknown };
    if (!Array.isArray(input?.attestations) || input.attestations.length === 0) {
      throw new PantryIngestError("provenance_rejected", "Published provenance was malformed");
    }
    const purlName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
    const expectedName = `pkg:npm/${purlName}@${version}`;
    for (const item of input.attestations) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new PantryIngestError("provenance_rejected", "Published provenance was malformed");
      }
      const envelope = (item as { bundle?: { dsseEnvelope?: unknown } }).bundle?.dsseEnvelope;
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
        throw new PantryIngestError("provenance_rejected", "Published provenance was malformed");
      }
      const payload = (envelope as { payload?: unknown }).payload;
      if (typeof payload !== "string") {
        throw new PantryIngestError("provenance_rejected", "Published provenance was malformed");
      }
      let statement: { subject?: Array<{ name?: string; digest?: { sha512?: string } }> };
      try {
        statement = JSON.parse(
          new TextDecoder().decode(
            Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)),
          ),
        ) as typeof statement;
      } catch {
        throw new PantryIngestError("provenance_rejected", "Published provenance was malformed");
      }
      const bound = statement.subject?.some(
        (subject) => subject.name === expectedName && subject.digest?.sha512 === sha512Hex,
      );
      if (bound !== true) {
        throw new PantryIngestError(
          "provenance_rejected",
          "Published provenance did not bind the package bytes",
        );
      }
    }
    return { bytes, structurallyBound: true };
  }

  async fetchRegistryKeys(): Promise<Array<{ keyid: string; key: string }>> {
    const bytes = await this.fetchBytes(
      `${NPM_REGISTRY_ORIGIN}/-/npm/v1/keys`,
      MAX_ATTESTATION_BYTES,
      {
        accept: "application/json",
      },
    );
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
        keys?: unknown;
      };
      if (!Array.isArray(parsed.keys)) throw new Error();
      return parsed.keys.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const key = entry as { keyid?: unknown; key?: unknown };
        return typeof key.keyid === "string" && typeof key.key === "string"
          ? [{ keyid: key.keyid, key: key.key }]
          : [];
      });
    } catch {
      throw new PantryIngestError(
        "upstream_unavailable",
        "Registry signing keys were malformed",
        true,
      );
    }
  }

  private async fetchBytes(
    urlValue: string,
    limit: number,
    headers: Record<string, string>,
  ): Promise<Uint8Array> {
    let url = assertOfficialRegistryUrl(urlValue);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      this.fetchCounts.set(url.href, (this.fetchCounts.get(url.href) ?? 0) + 1);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.trustedFetch(
          new Request(url, {
            method: "GET",
            headers: { ...headers, "user-agent": "NabuFlow-Pantry/1" },
            redirect: "manual",
            signal: controller.signal,
          }),
        );
      } catch {
        throw new PantryIngestError("upstream_unavailable", "Registry request failed", true);
      } finally {
        clearTimeout(timeout);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null || redirects === MAX_REDIRECTS) {
          throw new PantryIngestError("upstream_unavailable", "Registry redirect was rejected");
        }
        url = assertOfficialRegistryUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw responseError(response);
      return readCapped(response, limit);
    }
    throw new PantryIngestError("upstream_unavailable", "Registry redirect was rejected");
  }
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function derP256ToP1363(der: Uint8Array): Uint8Array | null {
  if (der.byteLength < 8 || der[0] !== 0x30) return null;
  let offset = 2;
  if ((der[1] & 0x80) !== 0) {
    const lengthBytes = der[1] & 0x7f;
    if (lengthBytes < 1 || lengthBytes > 2) return null;
    offset = 2 + lengthBytes;
  }
  const parts: Uint8Array[] = [];
  for (let index = 0; index < 2; index += 1) {
    if (der[offset] !== 0x02) return null;
    const length = der[offset + 1];
    offset += 2;
    if (length === undefined || length < 1 || offset + length > der.byteLength) return null;
    let integer = der.slice(offset, offset + length);
    offset += length;
    while (integer.byteLength > 32 && integer[0] === 0) integer = integer.slice(1);
    if (integer.byteLength > 32) return null;
    const padded = new Uint8Array(32);
    padded.set(integer, 32 - integer.byteLength);
    parts.push(padded);
  }
  const raw = new Uint8Array(64);
  raw.set(parts[0], 0);
  raw.set(parts[1], 32);
  return raw;
}

export async function verifyNpmRegistrySignature(
  name: string,
  version: string,
  integrity: string,
  signatures: readonly NpmDistSignature[],
  keys: readonly { keyid: string; key: string }[],
): Promise<boolean> {
  const input = new TextEncoder().encode(`${name}@${version}:${integrity}`);
  for (const signature of signatures) {
    const key = keys.find((candidate) => candidate.keyid === signature.keyid);
    const der = base64ToBytes(signature.sig);
    const spki = key === undefined ? null : base64ToBytes(key.key);
    const raw = der === null ? null : derP256ToP1363(der);
    if (raw === null || spki === null) continue;
    try {
      const publicKey = await crypto.subtle.importKey(
        "spki",
        spki.slice().buffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      if (
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          raw.slice().buffer,
          input.slice().buffer,
        )
      ) {
        return true;
      }
    } catch {
      // Try remaining registry signatures/keys. No malformed value may escape verification.
    }
  }
  return false;
}

export async function verifyNpmSri(
  bytes: Uint8Array,
  integrity: string,
): Promise<{ ok: boolean; sha512Hex: string }> {
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/u.exec(integrity);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-512", new Uint8Array(bytes).buffer),
  );
  let binary = "";
  let hex = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
    hex += byte.toString(16).padStart(2, "0");
  }
  return { ok: match !== null && btoa(binary) === match[1], sha512Hex: hex };
}
