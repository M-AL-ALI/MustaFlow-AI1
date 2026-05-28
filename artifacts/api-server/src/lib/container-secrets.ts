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

import { inArray, and, eq } from "drizzle-orm";
import { db, secretsTable } from "@workspace/db";
import { encryptionService } from "./encryption";
import { logger } from "./logger";

export interface ContainerSecret {
  name: string;
  valueEncrypted: string;
  environment: string;
}

/** Environments that are safe to inject into the dev container. */
const DEV_ENVIRONMENTS = ["development", "testing"] as const;

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
  return db
    .select({
      name: secretsTable.name,
      valueEncrypted: secretsTable.valueEncrypted,
      environment: secretsTable.environment,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.projectId, projectId),
        inArray(secretsTable.environment, DEV_ENVIRONMENTS as unknown as string[]),
        eq(secretsTable.isPreviewSafe, true),
        eq(secretsTable.minRole, "viewer"),
      ),
    );
}

/**
 * Return a decrypted { KEY: value } env-var map for a dev container.
 * Only includes secrets with environment IN ('development', 'testing').
 * Decryption errors for individual secrets are caught and skipped.
 */
export async function getContainerSecretMap(projectId: number): Promise<Record<string, string>> {
  const rows = await getContainerSecrets(projectId);
  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      env[row.name] = encryptionService.decrypt(row.valueEncrypted);
    } catch {
      // skip secrets that can't be decrypted
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
    const secrets = await getContainerSecretMap(projectId);
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

/**
 * Redact any secret value (≥ 8 chars) found in `line`, replacing it with
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

  let redacted = line;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < 8) continue; // too short to reliably redact
    if (redacted.includes(value)) {
      redacted = redacted.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return redacted;
}
