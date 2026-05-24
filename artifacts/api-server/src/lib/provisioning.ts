/**
 * Task #738 — Auto-provision container + Postgres per new project.
 *
 * When a project is created with `builderMode = 'agentic'` the API kicks off
 * a background job that:
 *   1. Creates a Fly.io machine for the project (dev container).
 *   2. Provisions a Neon Postgres project and stores the connection string as
 *      the `DATABASE_URL` project secret.
 *   3. Stamps `containerId`, `neonProjectId`, and flips `provisioningStatus`
 *      to "ready" — only after BOTH pieces are persisted successfully.
 *
 * The job is idempotent: re-running it on a project that already has a
 * container / Neon DB will skip the corresponding step rather than create
 * duplicates. This is what makes "Retry provisioning" safe.
 *
 * Strictness: a project is only marked "ready" when it has a real
 * `containerId` AND a real `neonProjectId` AND a stored DATABASE_URL secret.
 * Any other outcome (API error, missing FLY_API_TOKEN, missing NEON_API_KEY)
 * marks the project as "error" with a human-readable `provisioningError`,
 * so the workspace header surfaces a Retry instead of a false-positive
 * "ready" badge.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, projectsTable, secretsTable } from "@workspace/db";
import { logger } from "./logger";
import { createContainer } from "./container";
import { encryptionService } from "./encryption";

const NEON_API_BASE = "https://console.neon.tech/api/v2";

/** Stable, deterministic Neon project name for a given MustaFlow project. */
function neonProjectNameFor(projectId: number): string {
  return `mf-project-${projectId}`;
}

/**
 * In-process set of project IDs whose provisioning job is currently running.
 * Prevents a duplicate background job from being kicked off if the user clicks
 * "Retry provisioning" twice in a row.
 */
const activeProvisioning = new Set<number>();

/**
 * Look up an existing Neon project by its (stable) name. Returns its Neon
 * project id if one already exists, otherwise null. Used so that retries
 * after a partial failure don't create a second Postgres project.
 */
async function findNeonProjectByName(name: string): Promise<string | null> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${NEON_API_BASE}/projects?search=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { projects?: Array<{ id: string; name: string }> };
    const match = data.projects?.find((p) => p.name === name);
    return match?.id ?? null;
  } catch (err) {
    logger.warn({ err, name }, "Neon project lookup failed");
    return null;
  }
}

/**
 * Fetch the connection URI for an existing Neon project. Used during retry
 * when we already have a `neonProjectId` but the DATABASE_URL secret was
 * never persisted (e.g. crash between Neon create + secret upsert).
 */
async function fetchNeonConnectionUri(neonProjectId: string): Promise<string | null> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return null;
  try {
    // Pull the default branch + role/database so we can construct the
    // connection URI request.
    const projRes = await fetch(`${NEON_API_BASE}/projects/${neonProjectId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!projRes.ok) return null;
    const projData = (await projRes.json()) as {
      project?: { default_branch_id?: string; default_endpoint_settings?: unknown };
      branch?: { id?: string };
    };
    const branchId = projData.project?.default_branch_id ?? projData.branch?.id;
    if (!branchId) return null;

    // Default role + database created by Neon when omitted are "neondb_owner"
    // / "neondb". For our created projects we asked for "mustaflow" / project
    // name, but we don't reliably remember those across restarts, so list the
    // databases and roles and pick the first ones.
    const dbsRes = await fetch(
      `${NEON_API_BASE}/projects/${neonProjectId}/branches/${branchId}/databases`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const rolesRes = await fetch(
      `${NEON_API_BASE}/projects/${neonProjectId}/branches/${branchId}/roles`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!dbsRes.ok || !rolesRes.ok) return null;
    const dbsData = (await dbsRes.json()) as { databases?: Array<{ name: string }> };
    const rolesData = (await rolesRes.json()) as { roles?: Array<{ name: string }> };
    const dbName = dbsData.databases?.[0]?.name;
    const roleName = rolesData.roles?.[0]?.name;
    if (!dbName || !roleName) return null;

    const uriRes = await fetch(
      `${NEON_API_BASE}/projects/${neonProjectId}/connection_uri?database_name=${encodeURIComponent(dbName)}&role_name=${encodeURIComponent(roleName)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!uriRes.ok) return null;
    const uriData = (await uriRes.json()) as { uri?: string };
    return uriData.uri ?? null;
  } catch (err) {
    logger.warn({ err, neonProjectId }, "Neon connection-uri fetch failed");
    return null;
  }
}

/** Call the Neon API to create a fresh Postgres project. */
async function createNeonProject(
  projectId: number,
  projectName: string,
): Promise<{ connectionString: string; neonProjectId: string } | null> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return null;

  const safeName = neonProjectNameFor(projectId);
  const dbName =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .slice(0, 32) || `project_${projectId}`;

  try {
    const res = await fetch(`${NEON_API_BASE}/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project: {
          name: safeName,
          pg_version: 16,
          default_database_name: dbName,
          default_role_name: "mustaflow",
          region_id: "aws-us-east-1",
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error({ projectId, status: res.status, err: errText }, "Neon project creation failed");
      return null;
    }

    const data = (await res.json()) as {
      connection_uris?: Array<{ connection_uri: string }>;
      project?: { id: string };
    };
    const connectionString = data.connection_uris?.[0]?.connection_uri;
    const neonProjectId = data.project?.id;
    if (!connectionString || !neonProjectId) return null;
    return { connectionString, neonProjectId };
  } catch (err) {
    logger.error({ err, projectId }, "Error calling Neon API");
    return null;
  }
}

/** Upsert the DATABASE_URL secret for a project. */
async function upsertDatabaseUrlSecret(projectId: number, connectionString: string): Promise<void> {
  const encrypted = encryptionService.encrypt(connectionString);
  const existing = await db
    .select({ id: secretsTable.id })
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));

  if (existing.length > 0) {
    await db
      .update(secretsTable)
      .set({ valueEncrypted: encrypted, updatedAt: new Date() })
      .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));
  } else {
    await db.insert(secretsTable).values({
      projectId,
      name: "DATABASE_URL",
      valueEncrypted: encrypted,
      environment: "development",
      category: "database",
    });
  }
}

async function markError(projectId: number, message: string): Promise<void> {
  await db
    .update(projectsTable)
    .set({ provisioningStatus: "error", provisioningError: message })
    .where(eq(projectsTable.id, projectId))
    .catch(() => {
      /* best-effort */
    });
}

/**
 * Run the full provisioning pipeline once. Safe to call multiple times — each
 * step checks whether it has already been done.
 */
export async function runProvisionProjectJob(projectId: number): Promise<void> {
  if (activeProvisioning.has(projectId)) {
    logger.info({ projectId }, "Provisioning already in flight — skipping duplicate");
    return;
  }
  activeProvisioning.add(projectId);

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) return;

    await db
      .update(projectsTable)
      .set({ provisioningStatus: "provisioning", provisioningError: null })
      .where(eq(projectsTable.id, projectId));

    // Strict pre-flight: both providers must be configured. Otherwise the
    // project would silently end up without real infra, which contradicts the
    // agentic-mode contract.
    if (!process.env.FLY_API_TOKEN) {
      await markError(
        projectId,
        "FLY_API_TOKEN is not configured. Add it in Secrets, then click Retry.",
      );
      return;
    }
    if (!process.env.NEON_API_KEY) {
      await markError(
        projectId,
        "NEON_API_KEY is not configured. Add it in Secrets, then click Retry.",
      );
      return;
    }

    // Step 1 — container (idempotent: skip if already present)
    let containerId = project.containerId;
    if (!containerId) {
      const info = await createContainer(projectId, project.stack);
      if (!info) {
        await markError(projectId, "Failed to create Fly.io machine for this project.");
        return;
      }
      containerId = info.containerId;
      await db
        .update(projectsTable)
        .set({
          containerId: info.containerId,
          containerUrl: info.containerUrl,
          containerStatus: info.status,
        })
        .where(eq(projectsTable.id, projectId));
    }

    // Step 2 — Neon Postgres. Idempotency is critical: a partial failure
    // (e.g. crash after Neon create but before persistence) must NOT result
    // in a second Postgres project being created. We use a stable name keyed
    // on the project id so a remote lookup can de-duplicate before any
    // create call, and we persist `neonProjectId` BEFORE attempting the
    // secret upsert so subsequent retries take the "already created" path.
    let neonProjectId = project.neonProjectId;
    let connectionString: string | null = null;

    if (!neonProjectId) {
      // Remote dedupe: if a previous run already created the Neon project
      // but crashed before we recorded the id, look it up by stable name.
      const existing = await findNeonProjectByName(neonProjectNameFor(projectId));
      if (existing) {
        neonProjectId = existing;
        await db
          .update(projectsTable)
          .set({
            neonProjectId: existing,
            dbProvider: "postgres",
            dbStatus: "connected",
            dbConnectionId: existing,
          })
          .where(eq(projectsTable.id, projectId));
        connectionString = await fetchNeonConnectionUri(existing);
      } else {
        const neon = await createNeonProject(projectId, project.name);
        if (!neon) {
          await markError(projectId, "Failed to create Neon Postgres project.");
          return;
        }
        neonProjectId = neon.neonProjectId;
        connectionString = neon.connectionString;
        // Persist the Neon id FIRST so that any failure after this point
        // (including a process crash) is recoverable without creating a
        // duplicate Neon project on retry.
        await db
          .update(projectsTable)
          .set({
            neonProjectId: neon.neonProjectId,
            dbProvider: "postgres",
            dbStatus: "connected",
            dbConnectionId: neon.neonProjectId,
          })
          .where(eq(projectsTable.id, projectId));
      }
    }

    // Ensure DATABASE_URL secret exists. On a fresh create we already have
    // the connection string; on a retry where neonProjectId was persisted
    // but the secret never landed, fetch the URI from Neon and (re)write it.
    if (!connectionString) {
      connectionString = await fetchNeonConnectionUri(neonProjectId);
    }
    if (!connectionString) {
      await markError(
        projectId,
        "Could not retrieve Neon connection string. Please retry provisioning.",
      );
      return;
    }
    try {
      await upsertDatabaseUrlSecret(projectId, connectionString);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      await markError(projectId, `Failed to store DATABASE_URL secret: ${msg}`);
      return;
    }

    // Strict success criteria: both infra pieces must be persisted before we
    // call this "ready". Re-read the row instead of trusting the in-memory
    // variables in case a concurrent retry partially mutated state.
    const [final] = await db
      .select({
        containerId: projectsTable.containerId,
        neonProjectId: projectsTable.neonProjectId,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!final?.containerId || !final?.neonProjectId) {
      await markError(
        projectId,
        "Provisioning completed without both a container and a database. Please retry.",
      );
      return;
    }

    await db
      .update(projectsTable)
      .set({ provisioningStatus: "ready", provisioningError: null })
      .where(eq(projectsTable.id, projectId));

    logger.info({ projectId }, "Project provisioning complete");
  } catch (err) {
    logger.error({ err, projectId }, "Provisioning job failed");
    const message = err instanceof Error ? err.message : "Unknown provisioning error";
    await markError(projectId, message);
  } finally {
    activeProvisioning.delete(projectId);
  }
}

/**
 * Fire-and-forget enqueue: runs the provisioning pipeline on the next tick so
 * the HTTP request that triggered it can return immediately. Errors are
 * captured into the project's `provisioningError` column.
 */
export function enqueueProvisionProjectJob(projectId: number): void {
  setImmediate(() => {
    void runProvisionProjectJob(projectId);
  });
}

/**
 * Boot recovery: any project left in `provisioning` when the server crashed is
 * picked back up. We re-enqueue (rather than mark as error) because the
 * pipeline is idempotent — steps that already completed will be skipped on
 * the re-run and the project will land in `ready` without user action.
 */
export async function resumeStuckProvisioningOnBoot(): Promise<void> {
  try {
    const stuck = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.provisioningStatus, "provisioning"),
          inArray(projectsTable.builderMode, ["agentic"]),
          sql`${projectsTable.deletedAt} IS NULL`,
        ),
      );
    if (stuck.length === 0) return;
    logger.info({ count: stuck.length }, "Resuming stuck agentic-provisioning jobs on boot");
    for (const row of stuck) {
      enqueueProvisionProjectJob(row.id);
    }
  } catch (err) {
    logger.warn({ err }, "Boot scan for stuck provisioning jobs failed (non-fatal)");
  }
}
