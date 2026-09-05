import { lookupNeonProjectsByStableName, neonProjectNameFor } from "./neon-project-lifecycle";

export interface NeonAllocationIntentState {
  dbProvider: string;
  dbStatus: string;
  neonProjectId: string | null;
  dbConnectionId: string | null;
}

function safeProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

/** Only a genuinely untouched row can authorize a new allocation attempt. */
export function mayStartNeonAllocation(state: NeonAllocationIntentState): boolean {
  return (
    state.dbProvider === "none" &&
    state.dbStatus === "none" &&
    state.neonProjectId === null &&
    state.dbConnectionId === null
  );
}

/** An empty provider catalog is not evidence that a previously sent POST failed. */
export function hasUnresolvedNeonAllocationIntent(state: NeonAllocationIntentState): boolean {
  const ids = [state.neonProjectId, state.dbConnectionId].filter((id) => id !== null);
  if (ids.length > 0) {
    return ids.some((id) => !safeProviderId(id)) || new Set(ids).size !== 1;
  }
  return state.dbProvider === "postgres";
}

/**
 * Read-only provider reconciliation. Never clears an intent, allocates, or
 * treats absent/unavailable/ambiguous lookup as permission to do either.
 * The caller must CAS the ownership receipt against the observed lifecycle.
 */
export async function reconcileNeonAllocationIntent(input: {
  projectId: number;
  state: NeonAllocationIntentState;
  recordOwnership(neonProjectId: string): Promise<boolean>;
}): Promise<string | null> {
  if (
    !Number.isSafeInteger(input.projectId) ||
    input.projectId < 1 ||
    input.state.dbProvider !== "postgres" ||
    input.state.neonProjectId !== null ||
    input.state.dbConnectionId !== null
  )
    return null;
  try {
    const lookup = await lookupNeonProjectsByStableName(
      neonProjectNameFor(input.projectId),
      AbortSignal.timeout(30_000),
    );
    if (lookup.kind !== "found" || lookup.projectIds.length !== 1) return null;
    const id = lookup.projectIds[0];
    if (!safeProviderId(id) || !(await input.recordOwnership(id))) return null;
    return id;
  } catch {
    return null;
  }
}

export type NeonAllocationOrganization =
  | { kind: "ready"; organizationId: string | null }
  | { kind: "unavailable" };

/**
 * Preserve explicit org-scoped configuration. Without it, select only a
 * single visible organization; never guess the first of several. A denied
 * organizations endpoint cannot establish the key's scope, so an explicit
 * NEON_ORG_ID is required in that case. No API-key-dependent global cache.
 */
export async function resolveNeonAllocationOrganization(
  apiKey: string,
  signal?: AbortSignal,
): Promise<NeonAllocationOrganization> {
  const explicit = process.env.NEON_ORG_ID?.trim();
  if (explicit)
    return safeProviderId(explicit)
      ? { kind: "ready", organizationId: explicit }
      : { kind: "unavailable" };
  if (!apiKey.trim()) return { kind: "unavailable" };
  try {
    const timeout = AbortSignal.timeout(8_000);
    const response = await fetch("https://console.neon.tech/api/v2/users/me/organizations", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) return { kind: "unavailable" };
    const reader = response.body.getReader();
    const bytes: number[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (bytes.length + chunk.value.byteLength > 32_768) return { kind: "unavailable" };
        for (const byte of chunk.value) bytes.push(byte);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)),
    );
    if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "unavailable" };
    const organizations = (body as Record<string, unknown>).organizations;
    if (
      !Array.isArray(organizations) ||
      organizations.length > 1 ||
      "pagination" in body ||
      "unavailable" in body
    )
      return { kind: "unavailable" };
    if (organizations.length === 0) return { kind: "ready", organizationId: null };
    const organization: unknown = organizations[0];
    if (!organization || typeof organization !== "object" || Array.isArray(organization)) {
      return { kind: "unavailable" };
    }
    const id = (organization as Record<string, unknown>).id;
    return safeProviderId(id) ? { kind: "ready", organizationId: id } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
