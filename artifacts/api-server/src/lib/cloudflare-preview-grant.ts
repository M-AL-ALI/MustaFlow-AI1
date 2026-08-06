import { randomBytes } from "node:crypto";
import {
  MAX_PREVIEW_GRANT_LIFETIME_SECONDS,
  PREVIEW_DATA_PREFIX,
  PREVIEW_GRANT_QUERY_PARAM,
  parseRuntimeIdentityForNamespace,
  parseTenantRuntimeConfig,
  signPreviewGrant,
  tenantServicePortSchema,
} from "@workspace/tenant-runtime-contracts";

const DEFAULT_GRANT_TTL_SECONDS = 5 * 60;

export interface CloudflarePreviewGrant {
  runtimeId: string;
  previewUrl: string;
  launchUrl: string;
  expiresAt: string;
}

interface GrantDependencies {
  nowMs?: number;
  randomJti?: () => string;
}

function previewGatewayOrigin(raw: string | undefined): string {
  if (!raw) throw new Error("CLOUDFLARE_RUNTIME_PREVIEW_URL is required for preview grants");
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev")) {
    throw new Error("CLOUDFLARE_RUNTIME_PREVIEW_URL must be an HTTPS workers.dev origin");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port) {
    throw new Error("CLOUDFLARE_RUNTIME_PREVIEW_URL must contain only a workers.dev origin");
  }
  return url.origin;
}

/**
 * Mint a staging Cloudflare preview grant when and only when Cloudflare is the
 * explicitly selected tenant runtime provider. The unset/Fly path returns
 * before reading any preview key material.
 */
export async function mintCloudflarePreviewGrant(
  input: {
    projectId: number;
    runtimeId: string;
    servicePort: number;
    ttlSeconds?: number;
  },
  environment: Record<string, string | undefined> = process.env,
  dependencies: GrantDependencies = {},
): Promise<CloudflarePreviewGrant | null> {
  if (environment.TENANT_RUNTIME_PROVIDER?.trim() !== "cloudflare") return null;

  const config = parseTenantRuntimeConfig(environment).cloudflare!;
  const privateKey = environment.CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY is required for preview grants");
  }
  const gatewayOrigin = previewGatewayOrigin(environment.CLOUDFLARE_RUNTIME_PREVIEW_URL);
  const identity = await parseRuntimeIdentityForNamespace(
    input.runtimeId,
    config.deploymentNamespace,
  );
  if (
    identity.projectId !== input.projectId ||
    identity.role !== "preview" ||
    identity.slot !== "primary"
  ) {
    throw new Error("Preview grant runtime does not match the requested scratch project");
  }
  const servicePort = tenantServicePortSchema.parse(input.servicePort);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_PREVIEW_GRANT_LIFETIME_SECONDS
  ) {
    throw new Error("Preview grant TTL is outside the approved bound");
  }

  const nowMs = dependencies.nowMs ?? Date.now();
  const issuedAt = Math.floor(nowMs / 1_000);
  const expiresAt = issuedAt + ttlSeconds;
  const grant = await signPreviewGrant(privateKey, {
    v: 1,
    iss: "nabuflow-api",
    aud: gatewayOrigin,
    sub: input.runtimeId,
    port: servicePort,
    iat: issuedAt,
    exp: expiresAt,
    jti: dependencies.randomJti?.() ?? randomBytes(18).toString("base64url"),
  });
  const previewUrl = `${gatewayOrigin}${PREVIEW_DATA_PREFIX}/${input.runtimeId}/`;
  return {
    runtimeId: input.runtimeId,
    previewUrl,
    launchUrl: `${previewUrl}?${PREVIEW_GRANT_QUERY_PARAM}=${encodeURIComponent(grant)}`,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  };
}
