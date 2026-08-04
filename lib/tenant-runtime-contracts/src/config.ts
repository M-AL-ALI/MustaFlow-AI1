import { z } from "zod";
import { validateDeploymentNamespace } from "./runtime-identity";

export const TENANT_RUNTIME_PROVIDERS = ["fly", "cloudflare"] as const;
export type TenantRuntimeProviderId = (typeof TENANT_RUNTIME_PROVIDERS)[number];

const optionalNonemptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const tenantRuntimeConfigInputSchema = z
  .object({
    TENANT_RUNTIME_PROVIDER: optionalNonemptyString,
    CLOUDFLARE_RUNTIME_CONTROL_URL: optionalNonemptyString,
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: optionalNonemptyString,
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: optionalNonemptyString,
  })
  .strict();

export interface TenantRuntimeConfig {
  provider: TenantRuntimeProviderId;
  cloudflare?: {
    controlUrl: string;
    controlToken: string;
    deploymentNamespace: string;
  };
}

function optionalEnvironmentValue(
  environment: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return environment[name];
}

export function parseTenantRuntimeConfig(
  environment: Record<string, string | undefined>,
): TenantRuntimeConfig {
  const parsed = tenantRuntimeConfigInputSchema.parse({
    TENANT_RUNTIME_PROVIDER: optionalEnvironmentValue(environment, "TENANT_RUNTIME_PROVIDER"),
    CLOUDFLARE_RUNTIME_CONTROL_URL: optionalEnvironmentValue(
      environment,
      "CLOUDFLARE_RUNTIME_CONTROL_URL",
    ),
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: optionalEnvironmentValue(
      environment,
      "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
    ),
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: optionalEnvironmentValue(
      environment,
      "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
    ),
  });

  const provider = parsed.TENANT_RUNTIME_PROVIDER ?? "fly";
  if (!TENANT_RUNTIME_PROVIDERS.includes(provider as TenantRuntimeProviderId)) {
    throw new Error(`Unsupported TENANT_RUNTIME_PROVIDER: ${provider}`);
  }

  const anyCloudflareValue =
    parsed.CLOUDFLARE_RUNTIME_CONTROL_URL !== undefined ||
    parsed.CLOUDFLARE_RUNTIME_CONTROL_TOKEN !== undefined ||
    parsed.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== undefined;

  if (provider === "fly" && !anyCloudflareValue) return { provider: "fly" };

  if (
    !parsed.CLOUDFLARE_RUNTIME_CONTROL_URL ||
    !parsed.CLOUDFLARE_RUNTIME_CONTROL_TOKEN ||
    !parsed.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE
  ) {
    throw new Error("Cloudflare runtime configuration requires control URL, token, and namespace");
  }

  const controlUrl = new URL(parsed.CLOUDFLARE_RUNTIME_CONTROL_URL);
  if (controlUrl.protocol !== "https:") {
    throw new Error("CLOUDFLARE_RUNTIME_CONTROL_URL must use HTTPS");
  }
  if (controlUrl.username || controlUrl.password || controlUrl.search || controlUrl.hash) {
    throw new Error(
      "CLOUDFLARE_RUNTIME_CONTROL_URL cannot contain credentials, a query, or a fragment",
    );
  }
  if (parsed.CLOUDFLARE_RUNTIME_CONTROL_TOKEN.length < 32) {
    throw new Error("CLOUDFLARE_RUNTIME_CONTROL_TOKEN must contain at least 32 characters");
  }

  return {
    provider: provider as TenantRuntimeProviderId,
    cloudflare: {
      controlUrl: controlUrl.toString().replace(/\/$/, ""),
      controlToken: parsed.CLOUDFLARE_RUNTIME_CONTROL_TOKEN,
      deploymentNamespace: validateDeploymentNamespace(
        parsed.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
      ),
    },
  };
}
