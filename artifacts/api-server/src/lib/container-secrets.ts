/**
 * Task #767 — Container-scoped secret helper.
 *
 * The dev/preview container should only ever see secrets scoped to
 * `environment IN ('development', 'testing')`. Production and staging secrets
 * must never leak into the dev container's env.
 *
 * This module is the single place that enforces that filter and is used by
 * all callers that inject secrets into a running container:
 *   - livePreviewProxy.ts  (wakeContainer)
 *   - containers.ts        (loadProjectSecretsAsEnv for /container/start)
 *   - container.ts         (restartContainerWithSecrets callers)
 *   - provisioning.ts      (runProvisionProjectJob secret injection)
 *   - container-logs.ts    (log-line redaction)
 */

import { eq } from "drizzle-orm";
import { db, secretsTable } from "@workspace/db";
import { encryptionService } from "./encryption";
import { logger } from "./logger";
import {
  buildRuntimeSecretMap,
  redactSecretMapValues,
  secretCanInjectAtRuntime,
  type ProjectSecretRuntime,
} from "./project-secret-policy";

export { redactSecretMapValues, secretCanInjectAtRuntime } from "./project-secret-policy";
export type { ProjectSecretRuntime } from "./project-secret-policy";

export interface ContainerSecret {
  name: string;
  valueEncrypted: string;
  environment: string;
  isPreviewSafe: boolean;
  minRole: string;
}

async function loadProjectSecretRows(projectId: number): Promise<ContainerSecret[]> {
  return db
    .select({
      name: secretsTable.name,
      valueEncrypted: secretsTable.valueEncrypted,
      environment: secretsTable.environment,
      isPreviewSafe: secretsTable.isPreviewSafe,
      minRole: secretsTable.minRole,
    })
    .from(secretsTable)
    .where(eq(secretsTable.projectId, projectId));
}

/**
 * Load secrets for a project that are scoped to development or testing AND
 * satisfy both container-safety policies:
 *
 *  1. is_preview_safe = true — user-explicit opt-in for container injection.
 *  2. min_role = 'viewer'   — only secrets accessible to the lowest org role
 *     are auto-injected. Secrets gated to admin/owner must not leak to the
 *     autonomous agent container which runs without a specific user identity.
 *
 * Secrets that fail either check are silently excluded (visible count shown
 * in the Secrets panel warning banner so users can remediate).
 */
export async function getContainerSecrets(projectId: number): Promise<ContainerSecret[]> {
  const rows = await loadProjectSecretRows(projectId);
  return rows.filter((row) => secretCanInjectAtRuntime(row, "preview"));
}

/**
 * Return a decrypted { KEY: value } env-var map for a dev container.
 * Only includes secrets with environment IN ('development', 'testing').
 * Decryption errors for individual secrets are caught and skipped.
 */
export async function getContainerSecretMap(projectId: number): Promise<Record<string, string>> {
  return getProjectSecretMap(projectId, "preview");
}

/** Build-time environment for server-side build and validation containers. */
export async function getBuildSecretMap(projectId: number): Promise<Record<string, string>> {
  return getProjectSecretMap(projectId, "build");
}

/** Published server runtime environment. Never includes draft/test values. */
export async function getProductionSecretMap(projectId: number): Promise<Record<string, string>> {
  return getProjectSecretMap(projectId, "production");
}

export async function getProjectSecretMap(
  projectId: number,
  runtime: ProjectSecretRuntime,
): Promise<Record<string, string>> {
  const rows = await loadProjectSecretRows(projectId);
  return buildRuntimeSecretMap(rows, runtime, (value) => encryptionService.decrypt(value));
}

async function getAllProjectSecretMap(projectId: number): Promise<Record<string, string>> {
  const rows = await loadProjectSecretRows(projectId);
  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      env[row.name] = encryptionService.decrypt(row.valueEncrypted);
    } catch {
      // skip secrets that cannot be decrypted
    }
  }
  return env;
}

// ─── Secret cache for log-line redaction ─────────────────────────────────────
// Maps projectId → { secrets: Record<string, string>; expiresAt: number }
// TTL: 60 seconds. If the secret list cannot be loaded, we write the log
// line as-is but prepend [redaction-unavailable] as a marker.

interface SecretCacheEntry {
  secrets: Record<string, string>;
  expiresAt: number;
}

const secretCache = new Map<number, SecretCacheEntry>();
const CACHE_TTL_MS = 60_000;

/**
 * Get decrypted container secrets for a project, cached for 60 seconds.
 * Used exclusively for log-line redaction to avoid a DB round-trip per line.
 */
export async function getCachedContainerSecretMap(
  projectId: number,
): Promise<Record<string, string> | null> {
  const now = Date.now();
  const cached = secretCache.get(projectId);
  if (cached && cached.expiresAt > now) {
    return cached.secrets;
  }

  try {
    // Redaction deliberately covers every project secret, not only values that
    // are eligible for the current preview container. A production value that
    // accidentally reaches an error string must still be removed.
    const secrets = await getAllProjectSecretMap(projectId);
    secretCache.set(projectId, { secrets, expiresAt: now + CACHE_TTL_MS });
    return secrets;
  } catch (err) {
    logger.debug({ err, projectId }, "getCachedContainerSecretMap failed");
    return null;
  }
}

/**
 * Invalidate the cached secret map for a project. Call when secrets change
 * so the next log line gets a fresh list.
 */
export function invalidateContainerSecretCache(projectId: number): void {
  secretCache.delete(projectId);
}

/** Decrypted literals used only for exact-match redaction at persistence boundaries. */
export async function getProjectSecretLiterals(projectId: number): Promise<string[]> {
  const secrets = await getCachedContainerSecretMap(projectId);
  if (secrets === null) return [];
  return Object.values(secrets).filter((value) => value.length > 0);
}

/**
 * Redact any non-empty secret value found in `line`, replacing it with
 * `[REDACTED:<NAME>]`. Returns the redacted string.
 *
 * If secrets cannot be loaded, prepends `[redaction-unavailable] ` as a
 * marker and returns the line as-is.
 */
export async function redactSecretValuesInLog(projectId: number, line: string): Promise<string> {
  const secrets = await getCachedContainerSecretMap(projectId);

  if (secrets === null) {
    return `[redaction-unavailable] ${line}`;
  }

  return redactSecretMapValues(line, secrets);
}
