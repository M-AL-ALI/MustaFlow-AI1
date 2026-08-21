import { z } from "zod";
import { validateDeploymentNamespace } from "./runtime-identity";

export const TENANT_RUNTIME_PROVIDERS = ["fly", "cloudflare"] as const;
export type TenantRuntimeProviderId = (typeof TENANT_RUNTIME_PROVIDERS)[number];

export const CLOUDFLARE_RUNTIME_BINDING_NAMES = [
  "CLOUDFLARE_RUNTIME_CONTROL_URL",
  "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
  "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
] as const;
export type CloudflareRuntimeBindingName = (typeof CLOUDFLARE_RUNTIME_BINDING_NAMES)[number];

export const FLY_RUNTIME_BINDING_NAMES = [
  "FLY_API_TOKEN",
  "FLY_APP_NAME",
  "FLY_ORG_SLUG",
  "FLY_REGION",
] as const;
export type FlyRuntimeBindingName = (typeof FLY_RUNTIME_BINDING_NAMES)[number];
export type TenantRuntimeBindingName = CloudflareRuntimeBindingName | FlyRuntimeBindingName;

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
    FLY_API_TOKEN: optionalNonemptyString,
    FLY_APP_NAME: optionalNonemptyString,
    FLY_ORG_SLUG: optionalNonemptyString,
    FLY_REGION: optionalNonemptyString,
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
  partialFly?: {
    status: "partial-config";
    missingBindings: FlyRuntimeBindingName[];
  };
}

const flyResourceNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const flyRegionPattern = /^[a-z]{3}$/u;

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
    FLY_API_TOKEN: optionalEnvironmentValue(environment, "FLY_API_TOKEN"),
    FLY_APP_NAME: optionalEnvironmentValue(environment, "FLY_APP_NAME"),
    FLY_ORG_SLUG: optionalEnvironmentValue(environment, "FLY_ORG_SLUG"),
    FLY_REGION: optionalEnvironmentValue(environment, "FLY_REGION"),
  });

  const provider = parsed.TENANT_RUNTIME_PROVIDER ?? "fly";
  if (!TENANT_RUNTIME_PROVIDERS.includes(provider as TenantRuntimeProviderId)) {
    throw new Error(`Unsupported TENANT_RUNTIME_PROVIDER: ${provider}`);
  }

  if (provider === "fly" && parsed.FLY_API_TOKEN !== undefined) {
    const missingBindings = FLY_RUNTIME_BINDING_NAMES.filter((name) => parsed[name] === undefined);
    if (missingBindings.length > 0) {
      return {
        provider: "fly",
        partialFly: { status: "partial-config", missingBindings },
      };
    }

    if (!flyResourceNamePattern.test(parsed.FLY_APP_NAME!)) {
      throw new Error("FLY_APP_NAME must be a lowercase Fly resource name");
    }
    if (!flyResourceNamePattern.test(parsed.FLY_ORG_SLUG!)) {
      throw new Error("FLY_ORG_SLUG must be a lowercase Fly resource name");
    }
    if (!flyRegionPattern.test(parsed.FLY_REGION!)) {
      throw new Error("FLY_REGION must be a three-letter lowercase region code");
    }
  }

  const anyCloudflareValue =
    parsed.CLOUDFLARE_RUNTIME_CONTROL_URL !== undefined ||
    parsed.CLOUDFLARE_RUNTIME_CONTROL_TOKEN !== undefined ||
    parsed.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== undefined;

  if (provider === "fly" && !anyCloudflareValue) return { provider: "fly" };

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
