/**
 * Provider-neutral runtime manifest values that affect a tenant app process.
 *
 * `projects.runtime_port` is nullable so existing rows keep their historical
 * behavior. Callers name the legacy path they are preserving; an explicit
 * project value always wins.
 */

export const LEGACY_NODE_SERVICE_PORT = 3000;
export const LEGACY_FLASK_SERVICE_PORT = 5000;
export const LEGACY_FASTAPI_SERVICE_PORT = 8000;

export const MIN_TENANT_SERVICE_PORT = 1024;
export const MAX_TENANT_SERVICE_PORT = 65_535;

export type LegacyRuntimePortProfile = "stack" | "fixed-node";

export interface ProjectRuntimeManifest {
  servicePort: number;
  servicePortSource: "project" | "legacy-default";
}

export function isValidTenantServicePort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TENANT_SERVICE_PORT &&
    value <= MAX_TENANT_SERVICE_PORT
  );
}

export function legacyServicePortForStack(stack?: string | null): number {
  if (stack === "python-flask") return LEGACY_FLASK_SERVICE_PORT;
  if (stack === "python-fastapi") return LEGACY_FASTAPI_SERVICE_PORT;
  return LEGACY_NODE_SERVICE_PORT;
}

export function resolveProjectRuntimeManifest(input: {
  runtimePort?: number | null;
  stack?: string | null;
  legacyProfile?: LegacyRuntimePortProfile;
}): ProjectRuntimeManifest {
  if (isValidTenantServicePort(input.runtimePort)) {
    return { servicePort: input.runtimePort, servicePortSource: "project" };
  }

  return {
    servicePort:
      input.legacyProfile === "stack"
        ? legacyServicePortForStack(input.stack)
        : LEGACY_NODE_SERVICE_PORT,
    servicePortSource: "legacy-default",
  };
}
