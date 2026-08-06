import { describe, expect, it } from "vitest";
import { signPreviewGrant, verifyPreviewGrant } from "../src/preview-grant";
import { PREVIEW_GRANT_COMPATIBILITY_VECTOR as vector } from "./preview-grant-vector";

function decodeBase64Url(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privateKey: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

const claims = {
  v: 1 as const,
  iss: "nabuflow-api" as const,
  aud: "https://runtime-staging.example.workers.dev",
  sub: "nrf-0123456789abcdef-p42-preview-primary",
  port: 8080,
  iat: 1_785_859_200,
  exp: 1_785_859_500,
  jti: "preview-grant-test-jti",
};

describe("preview grants", () => {
  it("keeps API signing and Worker verification byte-compatible with raw P1363", async () => {
    const [encodedHeader, encodedClaims, encodedSignature] = vector.token.split(".");
    expect(new TextDecoder().decode(decodeBase64Url(encodedHeader))).toBe(vector.headerJson);
    expect(new TextDecoder().decode(decodeBase64Url(encodedClaims))).toBe(vector.claimsJson);
    expect(`${encodedHeader}.${encodedClaims}`).toBe(vector.signingInput);
    expect(decodeBase64Url(encodedSignature)).toHaveLength(64);
    expect(
      Array.from(decodeBase64Url(encodedSignature), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ).toBe(vector.signatureHex);
    await expect(verifyPreviewGrant(vector.publicKeyPem, vector.token)).resolves.toEqual({
      ok: true,
      claims: vector.claims,
    });

    // ECDSA is non-deterministic, so a fresh signature need not equal the fixed
    // bytes. Its canonical payload and raw 64-byte wire encoding must match.
    const fresh = await signPreviewGrant(vector.privateKeyPem, vector.claims);
    expect(fresh.slice(0, fresh.lastIndexOf("."))).toBe(vector.signingInput);
    expect(decodeBase64Url(fresh.split(".")[2])).toHaveLength(64);
    await expect(verifyPreviewGrant(vector.publicKeyPem, fresh)).resolves.toEqual({
      ok: true,
      claims: vector.claims,
    });
  });

  it("signs and verifies strict ES256 claims", async () => {
    const keys = await keyPair();
    const grant = await signPreviewGrant(keys.privateKey, claims);
    await expect(verifyPreviewGrant(keys.publicKey, grant)).resolves.toEqual({
      ok: true,
      claims,
    });
  });

  it("rejects tampering and a different signing key", async () => {
    const keys = await keyPair();
    const wrongKeys = await keyPair();
    const grant = await signPreviewGrant(keys.privateKey, claims);
    const segments = grant.split(".");
    const tampered = `${segments[0]}.${segments[1]}${segments[1].endsWith("A") ? "B" : "A"}.${segments[2]}`;
    await expect(verifyPreviewGrant(keys.publicKey, tampered)).resolves.toMatchObject({
      ok: false,
    });
    await expect(verifyPreviewGrant(wrongKeys.publicKey, grant)).resolves.toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects malformed and oversized compact grants without throwing", async () => {
    const keys = await keyPair();
    await expect(verifyPreviewGrant(keys.publicKey, "not.a.compact.grant")).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
    await expect(verifyPreviewGrant(keys.publicKey, "!".repeat(5_000))).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
