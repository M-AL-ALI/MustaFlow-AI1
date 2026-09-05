import { z } from "zod";
import { validateDeploymentNamespace } from "./runtime-identity";

export const TENANT_RUNTIME_PROVIDERS = ["cloudflare"] as const;
export type TenantRuntimeProviderId = (typeof TENANT_RUNTIME_PROVIDERS)[number];

export const CLOUDFLARE_RUNTIME_BINDING_NAMES = [
  "CLOUDFLARE_RUNTIME_CONTROL_URL",
  "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
  "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
] as const;
export type CloudflareRuntimeBindingName = (typeof CLOUDFLARE_RUNTIME_BINDING_NAMES)[number];

export type TenantRuntimeBindingName = CloudflareRuntimeBindingName;

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
  partialCloudflare?: {
    status: "partial-config";
    missingBindings: CloudflareRuntimeBindingName[];
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

  const provider = parsed.TENANT_RUNTIME_PROVIDER ?? "cloudflare";
  if (provider === "fly") {
    throw new Error("Fly runtime is retired; configure TENANT_RUNTIME_PROVIDER=cloudflare");
  }
  if (!TENANT_RUNTIME_PROVIDERS.includes(provider as TenantRuntimeProviderId)) {
    throw new Error(`Unsupported TENANT_RUNTIME_PROVIDER: ${provider}`);
  }

  const missingBindings = CLOUDFLARE_RUNTIME_BINDING_NAMES.filter(
    (name) => parsed[name] === undefined,
  );
  if (missingBindings.length > 0) {
    return {
      provider: provider as TenantRuntimeProviderId,
      partialCloudflare: { status: "partial-config", missingBindings },
    };
  }

  const controlUrlValue = parsed.CLOUDFLARE_RUNTIME_CONTROL_URL;
  const controlToken = parsed.CLOUDFLARE_RUNTIME_CONTROL_TOKEN;
  const deploymentNamespace = parsed.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE;
  if (!controlUrlValue || !controlToken || !deploymentNamespace) {
    throw new Error("Cloudflare runtime configuration completeness check failed");
  }

  const controlUrl = new URL(controlUrlValue);
  if (controlUrl.protocol !== "https:") {
    throw new Error("CLOUDFLARE_RUNTIME_CONTROL_URL must use HTTPS");
  }
  if (controlUrl.username || controlUrl.password || controlUrl.search || controlUrl.hash) {
    throw new Error(
      "CLOUDFLARE_RUNTIME_CONTROL_URL cannot contain credentials, a query, or a fragment",
    );
  }
  if (controlToken.length < 32) {
    throw new Error("CLOUDFLARE_RUNTIME_CONTROL_TOKEN must contain at least 32 characters");
  }

  return {
    provider: provider as TenantRuntimeProviderId,
    cloudflare: {
      controlUrl: controlUrl.toString().replace(/\/$/, ""),
      controlToken,
      deploymentNamespace: validateDeploymentNamespace(deploymentNamespace),
    },
  };
}
