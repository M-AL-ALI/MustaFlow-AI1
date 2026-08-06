import { generateKeyPairSync } from "node:crypto";
import { deriveRuntimeIdentity, verifyPreviewGrant } from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import { mintCloudflarePreviewGrant } from "./cloudflare-preview-grant";

// Mirror of the contracts-package compatibility vector. This private key is
// public test data only. Keeping the API assertion here proves the issuer
// boundary without pulling test sources across this package's rootDir.
const vector = {
  privateKeyPem: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZqQSR1D+CC69JD0Q
g0cVWWv9GV9xRDwJACmeFbbvu9ihRANCAARccmVKOQxtA98n4Y1H6wXtU44Zh9vj
eLbrsF4RiLGT1LD3jL0agmggLIq0aXXeIO53j5U1HjWVKvOJTy3YB4on
-----END PRIVATE KEY-----
`,
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXHJlSjkMbQPfJ+GNR+sF7VOOGYfb
43i267BeEYixk9Sw94y9GoJoICyKtGl13iDud4+VNR41lSrziU8t2AeKJw==
-----END PUBLIC KEY-----
`,
  claims: {
    v: 1 as const,
    iss: "nabuflow-api" as const,
    aud: "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev",
    sub: "nrf-e919a75364398a44-p424242-preview-primary",
    port: 8080,
    iat: 1_785_859_200,
    exp: 1_785_859_500,
    jti: "preview-vector-jti-0001",
  },
  signingInput:
    "eyJhbGciOiJFUzI1NiIsInR5cCI6Ik5BQlVGTE9XX1BSRVZJRVdfR1JBTlQifQ.eyJ2IjoxLCJpc3MiOiJuYWJ1Zmxvdy1hcGkiLCJhdWQiOiJodHRwczovL25hYnVmbG93LXJ1bnRpbWUtc3RhZ2luZy5tdXN0YWZhLWFsYWxpNzQud29ya2Vycy5kZXYiLCJzdWIiOiJucmYtZTkxOWE3NTM2NDM5OGE0NC1wNDI0MjQyLXByZXZpZXctcHJpbWFyeSIsInBvcnQiOjgwODAsImlhdCI6MTc4NTg1OTIwMCwiZXhwIjoxNzg1ODU5NTAwLCJqdGkiOiJwcmV2aWV3LXZlY3Rvci1qdGktMDAwMSJ9",
} as const;

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function cloudflareEnvironment(privateKey: string) {
  return {
    TENANT_RUNTIME_PROVIDER: "cloudflare",
    CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime-staging.example.workers.dev",
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
    CLOUDFLARE_RUNTIME_PREVIEW_URL: "https://runtime-staging.example.workers.dev",
    CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY: privateKey,
  };
}

describe("Cloudflare preview grant issuer", () => {
  it("uses the fixed raw-P1363 compatibility vector on the API signing side", async () => {
    const result = await mintCloudflarePreviewGrant(
      { projectId: 424_242, runtimeId: vector.claims.sub, servicePort: 8080 },
      {
        ...cloudflareEnvironment(vector.privateKeyPem),
        CLOUDFLARE_RUNTIME_CONTROL_URL: vector.claims.aud,
        CLOUDFLARE_RUNTIME_PREVIEW_URL: vector.claims.aud,
      },
      { nowMs: vector.claims.iat * 1_000, randomJti: () => vector.claims.jti },
    );
    const token = new URL(result!.launchUrl).searchParams.get("__nfg")!;
    expect(token.slice(0, token.lastIndexOf("."))).toBe(vector.signingInput);
    const signature = token.split(".")[2];
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    await expect(verifyPreviewGrant(vector.publicKeyPem, token)).resolves.toEqual({
      ok: true,
      claims: vector.claims,
    });
  });

  it("is inert when the provider is unset or Fly", async () => {
    await expect(
      mintCloudflarePreviewGrant({ projectId: 42, runtimeId: "not-read", servicePort: 3000 }, {}),
    ).resolves.toBeNull();
    await expect(
      mintCloudflarePreviewGrant(
        { projectId: 42, runtimeId: "not-read", servicePort: 3000 },
        { TENANT_RUNTIME_PROVIDER: "fly" },
      ),
    ).resolves.toBeNull();
  });

  it("mints a short-lived API-signed grant only for the matching preview runtime", async () => {
    const keys = keyPair();
    const runtimeId = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const result = await mintCloudflarePreviewGrant(
      { projectId: 42, runtimeId, servicePort: 8080 },
      cloudflareEnvironment(keys.privateKey),
      { nowMs: 1_785_859_200_000, randomJti: () => "issuer-test-jti-0001" },
    );
    expect(result).not.toBeNull();
    expect(result?.previewUrl).toBe(
      `https://runtime-staging.example.workers.dev/_nabuflow/preview/v1/${runtimeId}/`,
    );
    const grant = new URL(result!.launchUrl).searchParams.get("__nfg");
    expect(grant).not.toBeNull();
    await expect(verifyPreviewGrant(keys.publicKey, grant!)).resolves.toMatchObject({
      ok: true,
      claims: {
        aud: "https://runtime-staging.example.workers.dev",
        sub: runtimeId,
        port: 8080,
        iat: 1_785_859_200,
        exp: 1_785_859_500,
      },
    });
  });

  it("rejects production identities and the reserved port", async () => {
    const keys = keyPair();
    const runtimeId = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "production",
      slot: "blue",
    });
    await expect(
      mintCloudflarePreviewGrant(
        { projectId: 42, runtimeId, servicePort: 8080 },
        cloudflareEnvironment(keys.privateKey),
      ),
    ).rejects.toThrow("scratch project");
    const previewId = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    await expect(
      mintCloudflarePreviewGrant(
        { projectId: 42, runtimeId: previewId, servicePort: 3000 },
        cloudflareEnvironment(keys.privateKey),
      ),
    ).rejects.toThrow();
  });
});
