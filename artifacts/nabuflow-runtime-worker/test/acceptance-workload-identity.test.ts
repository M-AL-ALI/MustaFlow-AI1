import { describe, expect, it } from "vitest";
import type { AcceptanceProvisionerBindings } from "../src/acceptance-provisioner-model";
import { Es256AcceptanceWorkloadVerifier } from "../src/acceptance-workload-identity";

const NOW_MS = Date.parse("2026-08-11T12:00:00.000Z");

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function textBase64Url(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pem(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body =
    btoa(binary)
      .match(/.{1,64}/gu)
      ?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

async function fixture() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const env = {
    ACCEPTANCE_WORKLOAD_PUBLIC_KEYS: JSON.stringify({ test: pem(publicKey) }),
    ACCEPTANCE_WORKLOAD_ISSUER: "https://identity.staging.invalid",
    ACCEPTANCE_WORKLOAD_AUDIENCE: "nabuflow-acceptance-provisioner-staging",
    ACCEPTANCE_WORKLOAD_SUBJECTS: '["acceptance-runner"]',
  } as AcceptanceProvisionerBindings;
  const sign = async (overrides: Record<string, unknown> = {}) => {
    const header = textBase64Url({ alg: "ES256", typ: "JWT", kid: "test" });
    const payload = textBase64Url({
      iss: env.ACCEPTANCE_WORKLOAD_ISSUER,
      aud: env.ACCEPTANCE_WORKLOAD_AUDIENCE,
      sub: "acceptance-runner",
      iat: Math.floor(NOW_MS / 1_000) - 1,
      exp: Math.floor(NOW_MS / 1_000) + 300,
      jti: "acceptance-token-00000001",
      ...overrides,
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    );
    return `${header}.${payload}.${base64Url(signature)}`;
  };
  return { env, sign };
}

describe("acceptance workload identity", () => {
  it("accepts only a short-lived signed, allowlisted staging workload", async () => {
    const { env, sign } = await fixture();
    const verifier = new Es256AcceptanceWorkloadVerifier(env);
    const token = await sign();
    await expect(
      verifier.verify(
        new Request("https://acceptance.invalid", {
          headers: { authorization: `Bearer ${token}` },
        }),
        NOW_MS,
      ),
    ).resolves.toMatchObject({
      subject: "acceptance-runner",
      tokenId: "acceptance-token-00000001",
      expiresAtMs: NOW_MS + 300_000,
    });
  });

  it("rejects tampered, expired, wrong-audience, and unallowlisted tokens", async () => {
    const { env, sign } = await fixture();
    const verifier = new Es256AcceptanceWorkloadVerifier(env);
    const valid = await sign();
    const [header, payload, signature] = valid.split(".");
    const tampered = `${header}.${payload.slice(0, -1)}A.${signature}`;
    const candidates = [
      tampered,
      await sign({ exp: Math.floor(NOW_MS / 1_000) - 120 }),
      await sign({ aud: "foreign-audience" }),
      await sign({ sub: "foreign-runner" }),
    ];
    for (const token of candidates) {
      await expect(
        verifier.verify(
          new Request("https://acceptance.invalid", {
            headers: { authorization: `Bearer ${token}` },
          }),
          NOW_MS,
        ),
      ).resolves.toBeNull();
    }
  });
});
