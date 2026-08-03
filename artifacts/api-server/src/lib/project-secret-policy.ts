export interface ProjectSecretPolicyEntry {
  environment: string;
  isPreviewSafe: boolean;
  minRole: string;
}

export interface EncryptedProjectSecretPolicyEntry extends ProjectSecretPolicyEntry {
  name: string;
  valueEncrypted: string;
}

export type ProjectSecretRuntime = "build" | "preview" | "production";

const DEV_ENVIRONMENTS = ["development", "testing"] as const;

export const PROJECT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MASKED_SECRET_VALUE = "••••••••";

export function isValidProjectSecretName(name: string): boolean {
  return PROJECT_SECRET_NAME_PATTERN.test(name);
}

/** Pure policy used by every server-side runtime injection boundary. */
export function secretCanInjectAtRuntime(
  secret: ProjectSecretPolicyEntry,
  runtime: ProjectSecretRuntime,
): boolean {
  if (runtime === "production") return secret.environment === "production";
  return (
    DEV_ENVIRONMENTS.includes(secret.environment as (typeof DEV_ENVIRONMENTS)[number]) &&
    secret.isPreviewSafe &&
    secret.minRole === "viewer"
  );
}

/** Build a runtime env map while skipping values that cannot be decrypted. */
export function buildRuntimeSecretMap(
  entries: EncryptedProjectSecretPolicyEntry[],
  runtime: ProjectSecretRuntime,
  decrypt: (valueEncrypted: string) => string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (!secretCanInjectAtRuntime(entry, runtime)) continue;
    try {
      env[entry.name] = decrypt(entry.valueEncrypted);
    } catch {
      // A single bad ciphertext must not expose another environment or block
      // the remaining valid variables from reaching the runtime.
    }
  }
  return env;
}

/** Pure exact-value scrubber shared by log/error persistence boundaries. */
export function redactSecretMapValues(line: string, secrets: Record<string, string>): string {
  let redacted = line;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length === 0) continue;
    if (redacted.includes(value)) {
      redacted = redacted.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return redacted;
}
