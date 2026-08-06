import { z } from "zod";
import { tenantServicePortSchema } from "./service-port";

export const PREVIEW_DATA_PREFIX = "/_nabuflow/preview/v1";
export const PREVIEW_GRANT_QUERY_PARAM = "__nfg";
export const PREVIEW_GRANT_TYPE = "NABUFLOW_PREVIEW_GRANT";
export const PREVIEW_GRANT_VERSION = 1 as const;
export const MAX_PREVIEW_GRANT_LIFETIME_SECONDS = 10 * 60;
export const MAX_PREVIEW_GRANT_BYTES = 4_096;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export const previewGrantClaimsSchema = z
  .object({
    v: z.literal(PREVIEW_GRANT_VERSION),
    iss: z.literal("nabuflow-api"),
    aud: z.string().url(),
    sub: z.string().min(1).max(128),
    port: tenantServicePortSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().min(16).max(128).regex(base64UrlPattern),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat, "Preview grant expiry must follow issuance")
  .refine(
    (claims) => claims.exp - claims.iat <= MAX_PREVIEW_GRANT_LIFETIME_SECONDS,
    "Preview grant lifetime is too long",
  );

export type PreviewGrantClaims = z.infer<typeof previewGrantClaimsSchema>;

const previewGrantHeaderSchema = z
  .object({
    alg: z.literal("ES256"),
    typ: z.literal(PREVIEW_GRANT_TYPE),
  })
  .strict();

export type PreviewGrantVerification =
  | { ok: true; claims: PreviewGrantClaims }
  | { ok: false; reason: "malformed" | "invalid_signature" };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!base64UrlPattern.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    return binaryToBytes(binary);
  } catch {
    return null;
  }
}

function encodeJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  const bytes = base64UrlToBytes(value);
  if (bytes === null) throw new Error("Malformed base64url");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function pemBytes(pem: string, label: "PRIVATE KEY" | "PUBLIC KEY"): ArrayBuffer {
  const pattern = new RegExp(
    `^-----BEGIN ${label}-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END ${label}-----$`,
  );
  const match = pattern.exec(pem.trim());
  if (!match) throw new Error(`Preview ${label.toLowerCase()} must be PEM encoded`);
  const binary = atob(match[1].replace(/\s/g, ""));
  return binaryToBytes(binary).buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemBytes(pem, "PRIVATE KEY"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    pemBytes(pem, "PUBLIC KEY"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export async function signPreviewGrant(
  privateKeyPem: string,
  input: PreviewGrantClaims,
): Promise<string> {
  const claims = previewGrantClaimsSchema.parse(input);
  const encodedHeader = encodeJson({ alg: "ES256", typ: PREVIEW_GRANT_TYPE });
  const encodedClaims = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importPrivateKey(privateKeyPem),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyPreviewGrant(
  publicKeyPem: string,
  token: string,
): Promise<PreviewGrantVerification> {
  if (!token || token.length > MAX_PREVIEW_GRANT_BYTES) return { ok: false, reason: "malformed" };
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !base64UrlPattern.test(segment))) {
    return { ok: false, reason: "malformed" };
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  try {
    const header = previewGrantHeaderSchema.safeParse(decodeJson(encodedHeader));
    const claims = previewGrantClaimsSchema.safeParse(decodeJson(encodedClaims));
    const signature = base64UrlToBytes(encodedSignature);
    if (!header.success || !claims.success || signature === null || signature.byteLength !== 64) {
      return { ok: false, reason: "malformed" };
    }
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importPublicKey(publicKeyPem),
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    return valid ? { ok: true, claims: claims.data } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
