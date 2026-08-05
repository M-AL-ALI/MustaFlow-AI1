const textEncoder = new TextEncoder();
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_COMPONENT_PATTERN = /^[\x21-\x7e]+$/;

export const DEFAULT_CONTROL_CLOCK_SKEW_MS = 60_000;

export interface ControlSignatureFields {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  idempotencyKey: string;
}

export interface SignedControlRequest extends ControlSignatureFields {
  signature: string;
  body: string | Uint8Array;
}

export interface ControlNonceStore {
  /**
   * Atomically consume a nonce. Returns true only for its first use. Durable
   * Object implementations must retain it until expiresAtMs.
   */
  consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean>;
}

export type ControlSignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason: "malformed" | "clock-skew" | "body-hash-mismatch" | "signature-mismatch" | "replay";
    };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hexToFixedBytes(value: string, length: number): { bytes: Uint8Array; valid: boolean } {
  const output = new Uint8Array(length);
  const valid = value.length === length * 2 && /^[0-9a-f]+$/.test(value);
  if (!valid) return { bytes: output, valid: false };

  for (let index = 0; index < length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return { bytes: output, valid: true };
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  const leftDecoded = hexToFixedBytes(left, 32);
  const rightDecoded = hexToFixedBytes(right, 32);
  let difference = leftDecoded.valid && rightDecoded.valid ? 0 : 1;
  for (let index = 0; index < 32; index += 1) {
    difference |= leftDecoded.bytes[index] ^ rightDecoded.bytes[index];
  }
  return difference === 0;
}

function validateCanonicalField(name: string, value: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${name} is not canonical`);
  }
}

export function canonicalizeControlRequest(fields: ControlSignatureFields): string {
  const method = fields.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method) || fields.method !== method) {
    throw new Error("HTTP method must already be normalized uppercase ASCII");
  }
  if (
    !fields.pathAndQuery.startsWith("/") ||
    fields.pathAndQuery.startsWith("//") ||
    fields.pathAndQuery.includes("#") ||
    fields.pathAndQuery.includes("://")
  ) {
    throw new Error("Path and query must be an origin-form request target");
  }
  validateCanonicalField("Path and query", fields.pathAndQuery);
  if (!/^(?:[0-9]{10}|[0-9]{13})$/.test(fields.timestamp)) {
    throw new Error("Timestamp must be decimal Unix time");
  }
  if (
    fields.nonce.length < 16 ||
    fields.nonce.length > 200 ||
    !TOKEN_COMPONENT_PATTERN.test(fields.nonce)
  ) {
    throw new Error("Nonce is not canonical");
  }
  if (!HEX_SHA256_PATTERN.test(fields.bodySha256)) {
    throw new Error("Body SHA-256 must be normalized lowercase hexadecimal");
  }
  validateCanonicalField("Idempotency key", fields.idempotencyKey, true);
  if (fields.idempotencyKey && !TOKEN_COMPONENT_PATTERN.test(fields.idempotencyKey)) {
    throw new Error("Idempotency key is not canonical");
  }

  return [
    method,
    fields.pathAndQuery,
    fields.timestamp,
    fields.nonce,
    fields.bodySha256,
    fields.idempotencyKey,
  ].join("\n");
}

export async function sha256Hex(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string" ? textEncoder.encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", copyToArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

export async function signControlRequest(
  secret: string | Uint8Array,
  fields: ControlSignatureFields,
): Promise<string> {
  const secretBytes = typeof secret === "string" ? textEncoder.encode(secret) : secret;
  if (secretBytes.byteLength < 32)
    throw new Error("Control signing secret must be at least 32 bytes");
  const key = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(canonicalizeControlRequest(fields)),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyControlRequestSignature(
  secret: string | Uint8Array,
  request: SignedControlRequest,
  nonceStore: ControlNonceStore,
  options: { nowMs?: number; maxClockSkewMs?: number } = {},
): Promise<ControlSignatureVerification> {
  try {
    canonicalizeControlRequest(request);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const rawTimestamp = Number(request.timestamp);
  const timestampMs = request.timestamp.length === 10 ? rawTimestamp * 1000 : rawTimestamp;
  const nowMs = options.nowMs ?? Date.now();
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CONTROL_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > maxClockSkewMs) {
    return { ok: false, reason: "clock-skew" };
  }

  const actualBodyHash = await sha256Hex(request.body);
  if (!constantTimeHexEqual(actualBodyHash, request.bodySha256)) {
    return { ok: false, reason: "body-hash-mismatch" };
  }

  const expectedSignature = await signControlRequest(secret, {
    method: request.method,
    pathAndQuery: request.pathAndQuery,
    timestamp: request.timestamp,
    nonce: request.nonce,
    bodySha256: request.bodySha256,
    idempotencyKey: request.idempotencyKey,
  });
  if (!constantTimeHexEqual(expectedSignature, request.signature)) {
    return { ok: false, reason: "signature-mismatch" };
  }

  // Use the later end of the accepted window so a replay remains blocked for
  // the entire period in which this signed request could pass clock validation.
  const consumed = await nonceStore.consumeOnce(request.nonce, timestampMs + maxClockSkewMs);
  if (!consumed) return { ok: false, reason: "replay" };

  return { ok: true };
}
