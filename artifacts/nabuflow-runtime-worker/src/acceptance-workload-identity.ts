import { acceptanceWorkloadClaimsSchema, sha256Hex } from "@workspace/tenant-runtime-contracts";
import type {
  AcceptanceProvisionerBindings,
  AcceptanceWorkloadIdentity,
  AcceptanceWorkloadVerifier,
} from "./acceptance-provisioner-model";

const MAX_TOKEN_BYTES = 4_096;
const CLOCK_SKEW_SECONDS = 60;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!base64UrlPattern.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJson(value: string): unknown {
  const bytes = base64UrlToBytes(value);
  if (bytes === null) throw new Error("Malformed workload token");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    bytes.fill(0);
  }
}

function importSpkiPem(pem: string): Promise<CryptoKey> {
  const match =
    /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PUBLIC KEY-----$/u.exec(
      pem.trim(),
    );
  if (match === null) throw new Error("Workload public key is malformed");
  const binary = atob(match[1].replace(/\s/gu, ""));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return crypto.subtle.importKey("spki", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
}

export class Es256AcceptanceWorkloadVerifier implements AcceptanceWorkloadVerifier {
  constructor(private readonly env: AcceptanceProvisionerBindings) {}

  async verify(request: Request, nowMs: number): Promise<AcceptanceWorkloadIdentity | null> {
    const authorization = request.headers.get("authorization");
    if (authorization === null || !authorization.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length);
    if (token.length === 0 || token.length > MAX_TOKEN_BYTES) return null;
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !base64UrlPattern.test(segment))) {
      return null;
    }
    try {
      const header = decodeJson(segments[0]);
      if (typeof header !== "object" || header === null) return null;
      const headerRecord = header as Record<string, unknown>;
      if (
        headerRecord.alg !== "ES256" ||
        headerRecord.typ !== "JWT" ||
        typeof headerRecord.kid !== "string"
      ) {
        return null;
      }
      const keys = JSON.parse(this.env.ACCEPTANCE_WORKLOAD_PUBLIC_KEYS) as unknown;
      if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return null;
      const pem = (keys as Record<string, unknown>)[headerRecord.kid];
      if (typeof pem !== "string") return null;
      const signature = base64UrlToBytes(segments[2]);
      if (signature === null || signature.byteLength !== 64) return null;
      const valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        await importSpkiPem(pem),
        signature,
        new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
      );
      signature.fill(0);
      if (!valid) return null;
      const claims = acceptanceWorkloadClaimsSchema.safeParse(decodeJson(segments[1]));
      if (!claims.success) return null;
      const nowSeconds = Math.floor(nowMs / 1_000);
      if (
        claims.data.iss !== this.env.ACCEPTANCE_WORKLOAD_ISSUER ||
        !audienceContains(claims.data.aud, this.env.ACCEPTANCE_WORKLOAD_AUDIENCE) ||
        claims.data.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
        claims.data.exp < nowSeconds - CLOCK_SKEW_SECONDS
      ) {
        return null;
      }
      const subjects = JSON.parse(this.env.ACCEPTANCE_WORKLOAD_SUBJECTS) as unknown;
      if (!Array.isArray(subjects) || !subjects.every((value) => typeof value === "string")) {
        return null;
      }
      if (!subjects.includes(claims.data.sub)) return null;
      return {
        subject: claims.data.sub,
        subjectHash: await sha256Hex(`NABUFLOW_ACCEPTANCE_WORKLOAD_V1\n${claims.data.sub}`),
        tokenId: claims.data.jti,
        expiresAtMs: claims.data.exp * 1_000,
      };
    } catch {
      return null;
    }
  }
}

function audienceContains(audience: string | string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}
