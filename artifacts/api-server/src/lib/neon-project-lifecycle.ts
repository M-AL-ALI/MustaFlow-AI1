import { logger } from "./logger";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const NEON_LOOKUP_LIMIT = 100;
const NEON_LOOKUP_MAX_PAGES = 4;
const NEON_PROVIDER_TIMEOUT_MS = 8_000;
const NEON_LIST_SERVER_TIMEOUT_MS = 5_000;
const MAX_RELEASE_REFERENCES = 8;

function boundedProviderSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(NEON_PROVIDER_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type NeonStableNameLookup =
  | { kind: "found"; projectIds: readonly string[] }
  | { kind: "absent" }
  | { kind: "unavailable" };

function configuredApiKey(): string | null {
  return process.env.NEON_API_KEY?.trim() || null;
}

function safeProviderId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function safeStableName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Stable, deterministic Neon project name for a NabuFlow project. */
export function neonProjectNameFor(projectId: number): string {
  return `mf-project-${projectId}`;
}

/** Stable, deterministic Neon project name for a preview environment. */
export function neonPreviewProjectNameFor(projectId: number): string {
  return `mf-preview-${projectId}`;
}

/**
 * Bounded exact-name lookup. `unavailable` is intentionally distinct from
 * `absent`; callers performing destructive lifecycle work must fail closed.
 */
export async function lookupNeonProjectsByStableName(
  name: string,
  signal?: AbortSignal,
): Promise<NeonStableNameLookup> {
  const apiKey = configuredApiKey();
  if (!apiKey || !safeStableName(name)) return { kind: "unavailable" };

  try {
    const exactIds: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < NEON_LOOKUP_MAX_PAGES; page += 1) {
      signal?.throwIfAborted();
      const query = new URLSearchParams({
        search: name,
        limit: String(NEON_LOOKUP_LIMIT),
        timeout: String(NEON_LIST_SERVER_TIMEOUT_MS),
      });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${NEON_API_BASE}/projects?${query.toString()}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: boundedProviderSignal(signal),
      });
      if (!response.ok) {
        logger.warn({ status: response.status, name }, "Neon project lookup unavailable");
        return { kind: "unavailable" };
      }

      const body = (await response.json()) as {
        projects?: unknown;
        unavailable?: unknown;
        pagination?: { cursor?: unknown };
      };
      if (
        !Array.isArray(body.projects) ||
        !body.pagination ||
        (Array.isArray(body.unavailable) && body.unavailable.length > 0) ||
        (body.unavailable !== undefined && !Array.isArray(body.unavailable))
      ) {
        return { kind: "unavailable" };
      }
      for (const candidate of body.projects) {
        if (!candidate || typeof candidate !== "object") return { kind: "unavailable" };
        const project = candidate as { id?: unknown; name?: unknown };
        if (typeof project.id !== "string" || typeof project.name !== "string") {
          return { kind: "unavailable" };
        }
        if (!safeProviderId(project.id)) return { kind: "unavailable" };
        if (project.name === name) exactIds.push(project.id);
      }
      if (exactIds.length > MAX_RELEASE_REFERENCES) return { kind: "unavailable" };

      const nextCursor = body.pagination.cursor;
      if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
        if (body.projects.length >= NEON_LOOKUP_LIMIT) return { kind: "unavailable" };
        const projectIds = [...new Set(exactIds)].sort();
        return projectIds.length > 0 ? { kind: "found", projectIds } : { kind: "absent" };
      }
      if (
        typeof nextCursor !== "string" ||
        nextCursor.length > 512 ||
        seenCursors.has(nextCursor)
      ) {
        return { kind: "unavailable" };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return { kind: "unavailable" };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn({ errorName: errorName(error), name }, "Neon project lookup unavailable");
    return { kind: "unavailable" };
  }
}

/** Compatibility wrapper for ordinary provisioning retry behavior. */
export async function findNeonProjectByName(name: string): Promise<string | null> {
  const result = await lookupNeonProjectsByStableName(name);
  return result.kind === "found" ? (result.projectIds[0] ?? null) : null;
}

/**
 * Idempotently delete one Neon project and earn success with a final GET 404.
 * Provider bodies are deliberately neither read nor logged.
 */
export async function deleteNeonProjectAndProveAbsent(
  neonProjectId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const apiKey = configuredApiKey();
  if (!apiKey || !safeProviderId(neonProjectId)) return false;

  const projectUrl = `${NEON_API_BASE}/projects/${encodeURIComponent(neonProjectId)}`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    signal?.throwIfAborted();
    const before = await fetch(projectUrl, {
      headers,
      signal: boundedProviderSignal(signal),
    });
    if (before.status === 404) return true;
    if (!before.ok) {
      logger.warn(
        { status: before.status, neonProjectId },
        "Neon project deletion preflight unavailable",
      );
      return false;
    }

    const deletion = await fetch(projectUrl, {
      method: "DELETE",
      headers,
      signal: boundedProviderSignal(signal),
    });
    if (!(deletion.ok || deletion.status === 404)) {
      logger.warn(
        { status: deletion.status, neonProjectId },
        "Neon project deletion was not accepted",
      );
      return false;
    }

    const after = await fetch(projectUrl, {
      headers,
      signal: boundedProviderSignal(signal),
    });
    if (after.status === 404) return true;
    logger.warn({ status: after.status, neonProjectId }, "Neon project absence was not confirmed");
    return false;
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      { errorName: errorName(error), neonProjectId },
      "Neon project deletion unavailable",
    );
    return false;
  }
}

/**
 * Release known provider ids plus every exact match for both stable production
 * and preview names. This closes stale/missing database-pointer gaps without a
 * broad provider scan. The input ids are provider ids, not NabuFlow project ids.
 */
export async function releaseNeonProjectsForHardDelete(input: {
  projectIds: readonly string[];
  productionProjectName: string;
  previewProjectName: string;
  signal?: AbortSignal;
}): Promise<{ removed: number }> {
  if (
    input.projectIds.length > MAX_RELEASE_REFERENCES ||
    input.projectIds.some((id) => !safeProviderId(id)) ||
    !/^mf-project-\d+$/u.test(input.productionProjectName) ||
    !/^mf-preview-\d+$/u.test(input.previewProjectName)
  ) {
    throw new Error("project_purge_database_release_failed");
  }

  input.signal?.throwIfAborted();
  const production = await lookupNeonProjectsByStableName(
    input.productionProjectName,
    input.signal,
  );
  if (production.kind === "unavailable") {
    throw new Error("project_purge_database_release_failed");
  }
  input.signal?.throwIfAborted();
  const preview = await lookupNeonProjectsByStableName(input.previewProjectName, input.signal);
  if (preview.kind === "unavailable") {
    throw new Error("project_purge_database_release_failed");
  }

  const productionIds = production.kind === "found" ? production.projectIds : [];
  const previewIds = preview.kind === "found" ? preview.projectIds : [];
  const targets = [...new Set([...input.projectIds, ...productionIds, ...previewIds])].sort();
  if (targets.length > MAX_RELEASE_REFERENCES) {
    throw new Error("project_purge_database_release_failed");
  }

  for (const neonProjectId of targets) {
    input.signal?.throwIfAborted();
    if (!(await deleteNeonProjectAndProveAbsent(neonProjectId, input.signal))) {
      throw new Error("project_purge_database_release_failed");
    }
  }
  return { removed: targets.length };
}
