import { createHash, randomUUID } from "node:crypto";
import { resolveNeonAllocationOrganization } from "./neon-allocation-intent";

const NEON_BASE = "https://console.neon.tech/api/v2";
const PREVIEW_REGION = "aws-us-east-1";
const BODY_LIMIT = 128 * 1024;

export type PreviewDatabaseAllocationReceipt = {
  version: 1;
  projectId: number;
  allocationId: string;
  organizationId: string;
  regionId: string;
  provenance: "single-dispatch" | "legacy-unknown";
  providerProjectId: string | null;
};

export type PreviewDatabaseState = {
  status: string;
  hasCredential: boolean;
  allocation: unknown;
};

export type PreviewDatabaseDeletionEvidence = {
  version: 1;
  kind: "no-dispatch" | "provider-404";
  stateDigest: string;
};

type RecordReceipt = (
  expected: PreviewDatabaseAllocationReceipt | null,
  next: PreviewDatabaseAllocationReceipt,
) => Promise<boolean>;

type Authority = {
  signal?: AbortSignal;
  assertActive?: () => Promise<boolean>;
  fetch?: typeof fetch;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function unresolved(): never {
  throw new Error("project_purge_preview_allocation_unresolved");
}

export function parsePreviewDatabaseAllocation(
  projectId: number,
  value: unknown,
): PreviewDatabaseAllocationReceipt | null {
  if (!Number.isSafeInteger(projectId) || projectId < 1) return unresolved();
  if (value === null) return null;
  const row = record(value);
  if (
    !row ||
    row.version !== 1 ||
    row.projectId !== projectId ||
    typeof row.allocationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(row.allocationId) ||
    !providerId(row.organizationId) ||
    !providerId(row.regionId) ||
    !["single-dispatch", "legacy-unknown"].includes(String(row.provenance)) ||
    (row.providerProjectId !== null && !providerId(row.providerProjectId)) ||
    Object.keys(row).some(
      (key) =>
        ![
          "version",
          "projectId",
          "allocationId",
          "organizationId",
          "regionId",
          "provenance",
          "providerProjectId",
        ].includes(key),
    )
  )
    return unresolved();
  return {
    version: 1,
    projectId,
    allocationId: row.allocationId,
    organizationId: row.organizationId,
    regionId: row.regionId,
    provenance: row.provenance as PreviewDatabaseAllocationReceipt["provenance"],
    providerProjectId: row.providerProjectId as string | null,
  };
}

export function mayStartPreviewDatabaseAllocation(state: PreviewDatabaseState): boolean {
  return state.status === "none" && state.hasCredential === false && state.allocation === null;
}

export function hasUnresolvedPreviewDatabaseAllocation(
  projectId: number,
  state: PreviewDatabaseState,
): boolean {
  try {
    const allocation = parsePreviewDatabaseAllocation(projectId, state.allocation);
    if (
      !["none", "provisioning", "ready", "error"].includes(state.status) ||
      typeof state.hasCredential !== "boolean"
    )
      return true;
    if (mayStartPreviewDatabaseAllocation(state)) return false;
    return (
      state.status === "none" ||
      allocation === null ||
      allocation.provenance !== "single-dispatch" ||
      allocation.providerProjectId === null
    );
  } catch {
    return true;
  }
}

export function previewDatabaseStateDigest(projectId: number, state: PreviewDatabaseState): string {
  const allocation = parsePreviewDatabaseAllocation(projectId, state.allocation);
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        projectId,
        status: state.status,
        hasCredential: state.hasCredential,
        allocation,
      }),
    )
    .digest("hex");
}

export function previewDatabaseEvidenceMatches(
  projectId: number,
  state: PreviewDatabaseState,
  value: unknown,
): value is PreviewDatabaseDeletionEvidence {
  if (hasUnresolvedPreviewDatabaseAllocation(projectId, state)) return false;
  const evidence = record(value);
  return (
    evidence?.version === 1 &&
    evidence.kind === (mayStartPreviewDatabaseAllocation(state) ? "no-dispatch" : "provider-404") &&
    evidence.stateDigest === previewDatabaseStateDigest(projectId, state) &&
    Object.keys(evidence).every((key) => ["version", "kind", "stateDigest"].includes(key))
  );
}

async function document(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) return unresolved();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BODY_LIMIT) return unresolved();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!parsed) return unresolved();
    return parsed;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function providerContext(
  authority: Authority,
  allocation: PreviewDatabaseAllocationReceipt | null,
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(authority.signal ? [authority.signal] : []),
  ]);
  async function active() {
    signal.throwIfAborted();
    if (authority.assertActive && !(await authority.assertActive())) {
      throw new Error("preview_database_authority_lost");
    }
  }
  await active();
  const apiKey = process.env.NEON_API_KEY?.trim();
  if (!apiKey) return unresolved();
  const organization = await resolveNeonAllocationOrganization(apiKey, signal);
  await active();
  // A personal-key lookup without an identified organization cannot pin durable ownership.
  if (organization.kind !== "ready" || organization.organizationId === null) return unresolved();
  if (allocation && allocation.organizationId !== organization.organizationId) return unresolved();
  const organizationId = organization.organizationId;
  const regionId = allocation?.regionId ?? PREVIEW_REGION;
  async function request(path: string, method = "GET", body?: unknown) {
    await active();
    const response = await (authority.fetch ?? fetch)(NEON_BASE + path, {
      method,
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await active();
    return response;
  }
  return { active, request, organizationId, regionId };
}

type ProviderContext = Awaited<ReturnType<typeof providerContext>>;
type Lookup = { kind: "found"; id: string } | { kind: "absent" | "unavailable" | "ambiguous" };

async function lookup(context: ProviderContext, projectId: number): Promise<Lookup> {
  try {
    const name = "mf-preview-" + projectId;
    const ids = new Set<string>();
    const matches: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 8; page++) {
      const query = new URLSearchParams({ org_id: context.organizationId, limit: "50" });
      if (cursor !== null) query.set("cursor", cursor);
      const body = await document(await context.request("/projects?" + query.toString()));
      if (!Array.isArray(body.projects) || body.projects.length > 50)
        return { kind: "unavailable" };
      for (const field of ["unavailable", "unavailable_project_ids"]) {
        if (field in body && (!Array.isArray(body[field]) || body[field].length !== 0)) {
          return { kind: "unavailable" };
        }
      }
      for (const candidate of body.projects) {
        const project = record(candidate);
        if (
          !project ||
          !providerId(project.id) ||
          typeof project.name !== "string" ||
          ids.has(project.id)
        )
          return { kind: "unavailable" };
        ids.add(project.id);
        if (project.org_id !== undefined && project.org_id !== context.organizationId) {
          return { kind: "unavailable" };
        }
        if (project.name === name) matches.push(project.id);
      }
      if (!("pagination" in body)) {
        return matches.length > 1
          ? { kind: "ambiguous" }
          : matches.length === 1
            ? { kind: "found", id: matches[0]! }
            : { kind: "absent" };
      }
      const next = record(body.pagination)?.cursor;
      if (
        typeof next !== "string" ||
        next.length === 0 ||
        next.length > 4096 ||
        cursors.has(next)
      ) {
        return { kind: "unavailable" };
      }
      cursors.add(next);
      cursor = next;
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

function ownedProject(
  body: Record<string, unknown>,
  id: string,
  projectId: number,
  context: ProviderContext,
): Record<string, unknown> {
  const project = record(body.project);
  if (
    !project ||
    project.id !== id ||
    project.name !== "mf-preview-" + projectId ||
    project.region_id !== context.regionId ||
    (project.org_id !== undefined && project.org_id !== context.organizationId)
  )
    return unresolved();
  return project;
}

function newReceipt(
  projectId: number,
  context: ProviderContext,
  provenance: PreviewDatabaseAllocationReceipt["provenance"],
  id: string | null,
): PreviewDatabaseAllocationReceipt {
  return {
    version: 1,
    projectId,
    allocationId: randomUUID(),
    organizationId: context.organizationId,
    regionId: context.regionId,
    provenance,
    providerProjectId: id,
  };
}

async function observe(
  context: ProviderContext,
  projectId: number,
  current: PreviewDatabaseAllocationReceipt | null,
  id: string,
  recordReceipt: RecordReceipt,
) {
  if (current?.providerProjectId && current.providerProjectId !== id) return unresolved();
  const body = await document(await context.request("/projects/" + encodeURIComponent(id)));
  const project = ownedProject(body, id, projectId, context);
  const next = current
    ? { ...current, providerProjectId: id }
    : newReceipt(projectId, context, "legacy-unknown", id);
  await context.active();
  if (!(await recordReceipt(current, next))) return unresolved();
  return { allocation: next, project };
}

/** Reconciliation never sends POST or clears uncertainty on an empty catalog. */
export async function reconcilePreviewDatabaseAllocation(
  input: Authority & {
    projectId: number;
    state: PreviewDatabaseState;
    recordReceipt: RecordReceipt;
  },
): Promise<PreviewDatabaseAllocationReceipt | null> {
  const current = parsePreviewDatabaseAllocation(input.projectId, input.state.allocation);
  const context = await providerContext(input, current);
  const result = await lookup(context, input.projectId);
  if (result.kind === "absent") return current;
  if (result.kind !== "found") return unresolved();
  return (await observe(context, input.projectId, current, result.id, input.recordReceipt))
    .allocation;
}

function credential(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname.endsWith(".neon.tech")
      ? value
      : null;
  } catch {
    return null;
  }
}

export async function ensurePreviewDatabaseAllocation(
  input: Authority & {
    projectId: number;
    name: string;
    state: PreviewDatabaseState;
    recordReceipt: RecordReceipt;
  },
): Promise<{ allocation: PreviewDatabaseAllocationReceipt; connectionString: string } | null> {
  try {
    const current = parsePreviewDatabaseAllocation(input.projectId, input.state.allocation);
    const context = await providerContext(input, current);
    const result = await lookup(context, input.projectId);
    if (result.kind === "unavailable" || result.kind === "ambiguous") return null;
    if (result.kind === "found") {
      const observed = await observe(
        context,
        input.projectId,
        current,
        result.id,
        input.recordReceipt,
      );
      if (observed.allocation.provenance !== "single-dispatch") return null;
      const branch = observed.project.default_branch_id;
      if (!providerId(branch)) return null;
      const path = "/projects/" + encodeURIComponent(result.id);
      const branchPath = path + "/branches/" + encodeURIComponent(branch);
      const databases = await document(await context.request(branchPath + "/databases"));
      const roles = await document(await context.request(branchPath + "/roles"));
      if (
        !Array.isArray(databases.databases) ||
        databases.databases.length !== 1 ||
        !Array.isArray(roles.roles) ||
        !roles.roles.some((role) => record(role)?.name === "mustaflow")
      ) {
        return null;
      }
      const databaseName = record(databases.databases[0])?.name;
      if (
        typeof databaseName !== "string" ||
        databaseName.length === 0 ||
        databaseName.length > 63
      ) {
        return null;
      }
      const query = new URLSearchParams({
        branch_id: branch,
        database_name: databaseName,
        role_name: "mustaflow",
      });
      const uri = await document(
        await context.request(path + "/connection_uri?" + query.toString()),
      );
      const connectionString = credential(uri.uri);
      return connectionString ? { allocation: observed.allocation, connectionString } : null;
    }
    if (!mayStartPreviewDatabaseAllocation(input.state)) return null;
    const dispatched = newReceipt(input.projectId, context, "single-dispatch", null);
    await context.active();
    if (!(await input.recordReceipt(null, dispatched))) return null;
    const databaseName =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, "-")
        .slice(0, 32) || "preview_" + input.projectId;
    // The durable CAS spends the only attempt. No POST retry, including after lost acknowledgement.
    const response = await context.request("/projects", "POST", {
      project: {
        name: "mf-preview-" + input.projectId,
        pg_version: 16,
        default_database_name: databaseName,
        default_role_name: "mustaflow",
        org_id: context.organizationId,
        region_id: context.regionId,
      },
    });
    if (response.status !== 201) return null;
    const body = await document(response);
    const project = record(body.project);
    if (
      !project ||
      !providerId(project.id) ||
      (project.name !== undefined && project.name !== "mf-preview-" + input.projectId) ||
      (project.region_id !== undefined && project.region_id !== context.regionId) ||
      (project.org_id !== undefined && project.org_id !== context.organizationId)
    )
      return null;
    const allocation = { ...dispatched, providerProjectId: project.id };
    await context.active();
    if (!(await input.recordReceipt(dispatched, allocation))) return null;
    const connectionString = credential(
      Array.isArray(body.connection_uris) ? record(body.connection_uris[0])?.connection_uri : null,
    );
    return connectionString ? { allocation, connectionString } : null;
  } catch {
    return null;
  }
}

export async function releasePreviewDatabaseAllocation(
  input: Authority & {
    projectId: number;
    state: PreviewDatabaseState;
  },
): Promise<PreviewDatabaseDeletionEvidence> {
  if (hasUnresolvedPreviewDatabaseAllocation(input.projectId, input.state)) return unresolved();
  if (input.signal?.aborted || (input.assertActive && !(await input.assertActive())))
    return unresolved();
  const stateDigest = previewDatabaseStateDigest(input.projectId, input.state);
  if (mayStartPreviewDatabaseAllocation(input.state)) {
    return { version: 1, kind: "no-dispatch", stateDigest };
  }
  const allocation = parsePreviewDatabaseAllocation(input.projectId, input.state.allocation)!;
  const context = await providerContext(input, allocation);
  const result = await lookup(context, input.projectId);
  if (
    result.kind === "unavailable" ||
    result.kind === "ambiguous" ||
    (result.kind === "found" && result.id !== allocation.providerProjectId)
  )
    return unresolved();
  const path = "/projects/" + encodeURIComponent(allocation.providerProjectId!);
  const before = await context.request(path);
  if (before.status !== 404) {
    if (result.kind !== "found") return unresolved();
    ownedProject(await document(before), allocation.providerProjectId!, input.projectId, context);
    const deletion = await context.request(path, "DELETE");
    if (![200, 204, 404].includes(deletion.status)) return unresolved();
    if ((await context.request(path)).status !== 404) return unresolved();
  }
  await context.active();
  return { version: 1, kind: "provider-404", stateDigest };
}
