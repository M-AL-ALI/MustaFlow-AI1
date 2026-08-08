export const CONTROL_PROTOCOL_VERSION = "1" as const;
export const CONTROL_FEATURES = ["artifact-v1", "manifest-update-v1"] as const;

export const RUNTIME_ROLES = ["preview", "production"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export const RUNTIME_SLOTS = ["primary", "blue", "green"] as const;
export type RuntimeSlot = (typeof RUNTIME_SLOTS)[number];

export const RUNTIME_STATUSES = ["stopped", "starting", "running", "hibernated", "error"] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const CLOUDFLARE_RESERVED_SERVICE_PORT = 3000;
export const MIN_TENANT_SERVICE_PORT = 1024;
export const MAX_TENANT_SERVICE_PORT = 65535;

export function slotIsValidForRole(role: RuntimeRole, slot: RuntimeSlot): boolean {
  return role === "preview" ? slot === "primary" : slot === "blue" || slot === "green";
}
