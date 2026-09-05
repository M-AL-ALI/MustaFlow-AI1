import { lookupNeonProjectsByStableName, neonProjectNameFor } from "./neon-project-lifecycle";

import {
  mayStartNeonAllocation,
  resolveNeonAllocationOrganization,
} from "./neon-allocation-intent";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ALLOCATION_TIMEOUT_MS = 60_000;

export interface ManualNeonProject {
  id: number;
  name: string;
  dbProvider: string;
  dbStatus: string;
  dbConnectionId: string | null;
  neonProjectId: string | null;
}

export interface ManualNeonAllocationStore {
  /** Commit the intent before POST. A failed/uncertain write must never authorize POST. */
  recordIntent(): Promise<boolean>;
  /** Commit the provider id before validating/storing its connection credential. */
  recordOwnership(neonProjectId: string): Promise<boolean>;
}

type ProviderDocument = Record<string, unknown>;

function document(value: unknown): ProviderDocument | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderDocument)
    : null;
}

function providerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function connectionUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    const parsed = new URL(value);
    return ["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname ? value : null;
  } catch {
    return null;
  }
}

async function readProviderDocument(response: Response): Promise<ProviderDocument | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PROVIDER_BODY_BYTES) return null;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return document(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * The projects row is the durable intent/ownership registry for this path:
 * postgres + provisioning/error is an unresolved attempt, not permission to
 * POST again. The deterministic name is already understood by hard-delete.
 * Only an untouched none/none row may commit its one allocation attempt.
 * Retrying an uncertain attempt is read-only reconciliation, even after 404 or
 * an empty catalog: a timed-out POST may still be completing at the provider.
 * Callers must hold the project lifecycle session, including after disconnect.
 */
export async function ensureManualNeonAllocation(input: {
  project: ManualNeonProject;
  apiKey: string;
  assertActive(): Promise<boolean>;
  store: ManualNeonAllocationStore;
}): Promise<{ neonProjectId: string; connectionString: string } | null> {
  const { project, store } = input;
  if (!Number.isSafeInteger(project.id) || project.id < 1 || !input.apiKey.trim()) return null;
  const signal = AbortSignal.timeout(ALLOCATION_TIMEOUT_MS);
  const stableName = neonProjectNameFor(project.id);
  const knownIds = [
    ...new Set(
      [project.neonProjectId, project.dbConnectionId].filter((id): id is string => id !== null),
    ),
  ];
  if (knownIds.length > 1 || knownIds.some((id) => !providerId(id))) return null;

  async function assertActive(): Promise<void> {
    signal.throwIfAborted();
    if (!(await input.assertActive())) throw new Error("project_inactive");
  }

  async function providerRequest(
    path: string,
    body?: ProviderDocument,
  ): Promise<ProviderDocument | null> {
    await assertActive();
    const response = await fetch(`${NEON_API_BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return readProviderDocument(response);
  }

  try {
    await assertActive();
    const lookup = await lookupNeonProjectsByStableName(stableName, signal);
    if (lookup.kind === "unavailable") return null;
    const foundIds = lookup.kind === "found" ? lookup.projectIds : [];
    if (foundIds.length > 1 || foundIds.some((id) => !providerId(id))) return null;
    if (knownIds[0] && foundIds[0] && knownIds[0] !== foundIds[0]) return null;
    const existingId = knownIds[0] ?? foundIds[0];

    if (existingId) {
      const details = await providerRequest(`/projects/${encodeURIComponent(existingId)}`);
      const providerProject = document(details?.project);
      // Previously recorded timestamp-named manual databases remain recoverable.
      const ownedName = providerProject?.name;
      const legacyName = new RegExp(`^${stableName}-[0-9]{10,16}$`, "u");
      if (
        providerProject?.id !== existingId ||
        typeof ownedName !== "string" ||
        !(ownedName === stableName || (knownIds[0] === existingId && legacyName.test(ownedName)))
      )
        return null;
      await assertActive();
      if (!(await store.recordOwnership(existingId))) return null;

      const branchId = providerProject.default_branch_id ?? document(details?.branch)?.id;
      if (!providerId(branchId)) return null;
      const branchPath = `/projects/${encodeURIComponent(existingId)}/branches/${encodeURIComponent(branchId)}`;
      const databases = await providerRequest(`${branchPath}/databases`);
      const roles = await providerRequest(`${branchPath}/roles`);
      const databaseList = databases?.databases;
      const roleList = roles?.roles;
      // Never guess which user database to connect after a rename or ambiguity.
      if (!Array.isArray(databaseList) || databaseList.length !== 1 || !Array.isArray(roleList)) {
        return null;
      }
      const databaseName = document(databaseList[0])?.name;
      if (
        typeof databaseName !== "string" ||
        databaseName.length === 0 ||
        databaseName.length > 63 ||
        !roleList.some((role) => document(role)?.name === "mustaflow")
      )
        return null;
      const query = new URLSearchParams({
        branch_id: branchId,
        database_name: databaseName,
        role_name: "mustaflow",
      });
      const connection = await providerRequest(
        `/projects/${encodeURIComponent(existingId)}/connection_uri?${query.toString()}`,
      );
      const connectionString = connectionUri(connection?.uri);
      return connectionString ? { neonProjectId: existingId, connectionString } : null;
    }

    if (!mayStartNeonAllocation(project)) return null;
    await assertActive();
    const organization = await resolveNeonAllocationOrganization(input.apiKey, signal);
    if (organization.kind !== "ready") return null;
    await assertActive();
    if (!(await store.recordIntent())) return null;
    const databaseName =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, "-")
        .slice(0, 32) || `project_${project.id}`;
    // Exactly one POST. No transport/status retry and no delete-and-recreate.
    const created = await providerRequest("/projects", {
      project: {
        name: stableName,
        pg_version: 16,
        default_database_name: databaseName,
        default_role_name: "mustaflow",
        region_id: "aws-us-east-1",
        ...(organization.organizationId ? { org_id: organization.organizationId } : {}),
      },
    });
    const providerProject = document(created?.project);
    const id = providerProject?.id;
    if (
      !providerId(id) ||
      (providerProject?.name !== undefined && providerProject.name !== stableName)
    ) {
      return null;
    }
    await assertActive();
    if (!(await store.recordOwnership(id))) return null;
    const uris = created?.connection_uris;
    const connectionString = connectionUri(
      Array.isArray(uris) ? document(uris[0])?.connection_uri : null,
    );
    return connectionString ? { neonProjectId: id, connectionString } : null;
  } catch {
    // Provider bodies, credentials, and arbitrary exception text never leave this helper.
    return null;
  }
}
