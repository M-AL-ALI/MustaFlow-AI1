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
 *
 * Task #988 — Step-by-step progress tracking:
 * Each pipeline phase now stamps `provisioningStep` so the UI can render
 * a granular progress list. An in-memory rolling average of past completion
 * times drives `estimatedSecondsRemaining` on the status endpoint.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, projectsTable, secretsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  createContainer,
  ensureContainerLogTailer,
  hasContainerLayerCredentials,
  isContainerLayerConfigured,
} from "./tenant-runtime";
import { encryptionService } from "./encryption";
import { publishProvisioningStep } from "./event-bus";

const NEON_API_BASE = "https://console.neon.tech/api/v2";

// ── ETA: rolling average of past provisioning durations ───────────────────────
// Kept in-memory; resets on server restart (initialised to 60 s as a baseline
// so the first project gets a reasonable estimate before real data accumulates).
const ROLLING_WINDOW = 10;
const pastDurationsMs: number[] = [];
let rollingAverageMs = 60_000;

function recordCompletionDurationMs(durationMs: number): void {
  pastDurationsMs.push(durationMs);
  if (pastDurationsMs.length > ROLLING_WINDOW) pastDurationsMs.shift();
  rollingAverageMs = pastDurationsMs.reduce((a, b) => a + b, 0) / pastDurationsMs.length;
}

export function getRollingAverageMs(): number {
  return rollingAverageMs;
}

// ── Plain-English error message mapper ────────────────────────────────────────
// Maps raw API error text / HTTP status codes to user-facing messages.

function humanizeError(raw: string | undefined, provider: "fly" | "neon"): string {
  if (!raw) {
    return provider === "fly"
      ? "Could not reach Fly.io. Check your FLY_API_TOKEN and try again."
      : "Could not reach Neon. Check your NEON_API_KEY and try again.";
  }
  const lower = raw.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return provider === "fly"
      ? "Fly.io rejected our credentials — your FLY_API_TOKEN may be invalid or expired."
      : "Neon rejected our credentials — your NEON_API_KEY may be invalid or expired.";
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return provider === "fly"
      ? "Fly.io rate limit hit — please wait a moment and retry."
      : "Neon rate limit hit — please wait a moment and retry.";
  }
  if (
    lower.includes("quota") ||
    lower.includes("limit exceeded") ||
    lower.includes("project limit")
  ) {
    return "Account quota reached — you may need to delete unused projects or upgrade your plan.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return provider === "fly"
      ? "Fly.io timed out while creating the machine. The service may be under heavy load — please retry."
      : "Neon timed out while creating the database. Please retry.";
  }
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("internal server error")
  ) {
    return provider === "fly"
      ? "Fly.io is temporarily unavailable. Please retry in a few minutes."
      : "Neon is temporarily unavailable. Please retry in a few minutes.";
  }
  if (lower.includes("org_id") || lower.includes("organization")) {
    return "Neon organization configuration error — check your NEON_ORG_ID setting.";
  }
  if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return provider === "fly"
      ? "Could not reach Fly.io — check your network configuration."
      : "Could not reach Neon — check your network configuration.";
  }
  // Fall back to a sanitized excerpt of the raw error
  const excerpt = raw.slice(0, 120).replace(/\n/g, " ").trim();
  return provider === "fly" ? `Fly.io error: ${excerpt}` : `Neon error: ${excerpt}`;
}

/** Stable, deterministic Neon project name for a given MustaFlow project. */
function neonProjectNameFor(projectId: number): string {
  return `mf-project-${projectId}`;
}

/**
 * Cached Neon `org_id`. Org-scoped Neon API keys require `org_id` in the
 * project-create body or the request fails with HTTP 400 `org_id is required`.
 * Personal API keys ignore it. We prefer the explicit `NEON_ORG_ID` env var;
 * otherwise we auto-detect via /users/me/organizations the first time we need
 * it. A null cached value (after a resolved lookup) means "personal key, no
 * org needed" and we won't keep re-checking.
 */
let cachedNeonOrgId: string | null | undefined;

async function resolveNeonOrgId(apiKey: string): Promise<string | null> {
  if (cachedNeonOrgId !== undefined) return cachedNeonOrgId;
  const envOrgId = process.env.NEON_ORG_ID?.trim();
  if (envOrgId) {
    cachedNeonOrgId = envOrgId;
    return cachedNeonOrgId;
  }
  try {
    const res = await fetch(`${NEON_API_BASE}/users/me/organizations`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 403 || res.status === 404) {
      cachedNeonOrgId = null;
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, "Neon org_id lookup returned non-OK status; not caching");
      return null;
    }
    const data = (await res.json()) as { organizations?: Array<{ id: string }> };
    cachedNeonOrgId = data.organizations?.[0]?.id ?? null;
    return cachedNeonOrgId;
  } catch (err) {
    logger.warn({ err }, "Neon org_id auto-detection failed; not caching");
    return null;
  }
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

/** Call the Neon API to create a fresh Postgres project. Returns the error text on failure for better UX. */
async function createNeonProject(
  projectId: number,
  projectName: string,
): Promise<{ connectionString: string; neonProjectId: string } | { error: string }> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return { error: humanizeError(undefined, "neon") };

  const safeName = neonProjectNameFor(projectId);
  const dbName =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .slice(0, 32) || `project_${projectId}`;

  const orgId = await resolveNeonOrgId(apiKey);

  try {
    const body: { project: Record<string, unknown> } = {
      project: {
        name: safeName,
        pg_version: 16,
        default_database_name: dbName,
        default_role_name: "mustaflow",
        region_id: "aws-us-east-1",
      },
    };
    if (orgId) {
      body.project.org_id = orgId;
    }

    const res = await fetch(`${NEON_API_BASE}/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error({ projectId, status: res.status, err: errText }, "Neon project creation failed");
      return { error: humanizeError(`${res.status} ${errText}`, "neon") };
    }

    const data = (await res.json()) as {
      connection_uris?: Array<{ connection_uri: string }>;
      project?: { id: string };
    };
    const connectionString = data.connection_uris?.[0]?.connection_uri;
    const neonProjectId = data.project?.id;
    if (!connectionString || !neonProjectId)
      return { error: humanizeError("missing connection_uri or project.id in response", "neon") };
    return { connectionString, neonProjectId };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    logger.error({ err, projectId }, "Error calling Neon API");
    return { error: humanizeError(raw, "neon") };
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

/**
 * Mark a project as errored. Intentionally does NOT clear provisioningStep so
 * the UI can display a red X on the exact step that failed.
 */
async function markError(
  projectId: number,
  message: string,
  failedStep?: "create_container" | "create_database" | "connect_and_test",
): Promise<void> {
  await db
    .update(projectsTable)
    .set({ provisioningStatus: "error", provisioningError: message })
    .where(eq(projectsTable.id, projectId))
    .catch(() => {
      /* best-effort */
    });
  if (failedStep) {
    publishProvisioningStep({ projectId, step: failedStep, state: "failed", error: message });
  }
}

/** Stamp the current provisioning step and emit an EventBus start event. */
async function setStep(
  projectId: number,
  step: "create_container" | "create_database" | "connect_and_test",
): Promise<void> {
  await db
    .update(projectsTable)
    .set({ provisioningStep: step })
    .where(eq(projectsTable.id, projectId))
    .catch(() => {
      /* best-effort */
    });
  publishProvisioningStep({ projectId, step, state: "started" });
}

/** Emit an EventBus completion event for a step and optionally clear the DB step. */
async function completeStep(
  projectId: number,
  step: "create_container" | "create_database" | "connect_and_test",
): Promise<void> {
  publishProvisioningStep({ projectId, step, state: "completed" });
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

  const startedAt = new Date();

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) return;

    if (project.builderMode !== "agentic") {
      logger.info(
        { projectId, builderMode: project.builderMode },
        "Skipping provisioning for non-agentic project",
      );
      return;
    }

    await db
      .update(projectsTable)
      .set({
        provisioningStatus: "provisioning",
        provisioningError: null,
        provisioningStep: null,
        provisioningStartedAt: startedAt,
      })
      .where(eq(projectsTable.id, projectId));

    // Pre-flight: both providers must be operational/configured for full agentic provisioning.
    const containerLayerOperational = await isContainerLayerConfigured();
    if (!containerLayerOperational || !process.env.NEON_API_KEY) {
      const missing: string[] = [];
      if (!containerLayerOperational) missing.push("Fly container layer");
      if (!process.env.NEON_API_KEY) missing.push("NEON_API_KEY");
      logger.info(
        { projectId, missing },
        "Agentic provisioning skipped — credentials not configured (dev mode). Add secrets and retry.",
      );
      await db
        .update(projectsTable)
        .set({ provisioningStatus: "idle", provisioningError: null, provisioningStep: null })
        .where(eq(projectsTable.id, projectId))
        .catch(() => {
          /* best-effort */
        });

      // Clear any stale containerId that may have been stamped in a previous
      // environment where FLY_API_TOKEN was configured.  With Fly absent the
      // stored machine ID points to nothing real, which would leave the preview
      // proxy spinning forever on the cold-start page.
      if (!hasContainerLayerCredentials() && project.containerId) {
        await db
          .update(projectsTable)
          .set({ containerId: null, containerUrl: null, containerStatus: "stopped" })
          .where(eq(projectsTable.id, projectId))
          .catch(() => {
            /* best-effort */
          });
        logger.info(
          { projectId },
          "Cleared stale containerId — FLY_API_TOKEN not configured in this environment",
        );
      }

      return;
    }

    // Step 1 — container (idempotent: skip if already present)
    let containerId = project.containerId;
    if (!containerId) {
      await setStep(projectId, "create_container");
      let containerError: string | undefined;
      try {
        const info = await createContainer(projectId, project.stack);
        if (!info) {
          containerError = "Failed to create Fly.io machine for this project.";
        } else if ("error" in info) {
          containerError = humanizeError(info.error, "fly");
        } else {
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
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        containerError = humanizeError(raw, "fly");
      }
      if (containerError) {
        await markError(projectId, containerError, "create_container");
        return;
      }
      await completeStep(projectId, "create_container");
    }

    // Start tailing this machine's stdout/stderr
    if (containerId) {
      ensureContainerLogTailer(projectId, containerId);
    }

    // Step 2 — Neon Postgres
    let neonProjectId = project.neonProjectId;
    let connectionString: string | null = null;

    if (!neonProjectId) {
      await setStep(projectId, "create_database");
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
        if ("error" in neon) {
          await markError(projectId, neon.error, "create_database");
          return;
        }
        neonProjectId = neon.neonProjectId;
        connectionString = neon.connectionString;
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
      await completeStep(projectId, "create_database");
    }

    // Step 3 — connect and test (store DATABASE_URL secret)
    await setStep(projectId, "connect_and_test");

    if (!connectionString) {
      connectionString = await fetchNeonConnectionUri(neonProjectId);
    }
    if (!connectionString) {
      await markError(
        projectId,
        "Could not retrieve the database connection string. Please retry provisioning.",
        "connect_and_test",
      );
      return;
    }
    try {
      await upsertDatabaseUrlSecret(projectId, connectionString);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      await markError(projectId, `Failed to store DATABASE_URL secret: ${msg}`, "connect_and_test");
      return;
    }

    // Strict success criteria
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
        "connect_and_test",
      );
      return;
    }
    await completeStep(projectId, "connect_and_test");

    const durationMs = Date.now() - startedAt.getTime();
    recordCompletionDurationMs(durationMs);

    await db
      .update(projectsTable)
      .set({ provisioningStatus: "ready", provisioningError: null, provisioningStep: null })
      .where(eq(projectsTable.id, projectId));

    logger.info({ projectId, durationMs }, "Project provisioning complete");
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

// ─── Preview DB provisioning (Task #767) ─────────────────────────────────────

/** Stable Neon project name for a project's preview environment. */
function neonPreviewProjectNameFor(projectId: number): string {
  return `mf-preview-${projectId}`;
}

/**
 * Provision a dedicated Neon Postgres project for the preview environment.
 *
 * Stores the encrypted connection string in `projects.preview_db_url` and
 * stamps `preview_db_status = 'ready'`.  Idempotent: if a preview DB is
 * already provisioned (previewDbStatus = 'ready') the call is a no-op and
 * returns early.
 *
 * When NEON_API_KEY is missing, stamps previewDbStatus = 'error' with a
 * human-readable message — no throw, callers just surface the status.
 */
export async function provisionPreviewDb(projectId: number): Promise<void> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      previewDbStatus: projectsTable.previewDbStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) return;

  // Idempotent: already done.
  if (project.previewDbStatus === "ready") return;

  await db
    .update(projectsTable)
    .set({ previewDbStatus: "provisioning" })
    .where(eq(projectsTable.id, projectId));

  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    await db
      .update(projectsTable)
      .set({
        previewDbStatus: "error",
      })
      .where(eq(projectsTable.id, projectId));
    logger.warn({ projectId }, "provisionPreviewDb: NEON_API_KEY not set");
    return;
  }

  try {
    // Deduplicate by stable name — safe to call multiple times.
    const stableName = neonPreviewProjectNameFor(projectId);
    let connectionString: string | null = null;

    // Check if a preview Neon project already exists (e.g. from a failed/retried run).
    const existingId = await findNeonProjectByName(stableName);
    if (existingId) {
      connectionString = await fetchNeonConnectionUri(existingId);
    } else {
      // Create a new Neon project with the stable preview name.
      const orgId = await resolveNeonOrgId(apiKey);
      const dbName =
        project.name
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-")
          .slice(0, 32) || `preview_${projectId}`;

      const body: { project: Record<string, unknown> } = {
        project: {
          name: stableName,
          pg_version: 16,
          default_database_name: dbName,
          default_role_name: "mustaflow",
          region_id: "aws-us-east-1",
        },
      };
      if (orgId) body.project.org_id = orgId;

      const res = await fetch(`${NEON_API_BASE}/projects`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        logger.error(
          { projectId, status: res.status, err: errText },
          "Preview Neon project create failed",
        );
        await db
          .update(projectsTable)
          .set({ previewDbStatus: "error" })
          .where(eq(projectsTable.id, projectId));
        return;
      }
      const data = (await res.json()) as {
        connection_uris?: Array<{ connection_uri: string }>;
      };
      connectionString = data.connection_uris?.[0]?.connection_uri ?? null;
    }

    if (!connectionString) {
      await db
        .update(projectsTable)
        .set({ previewDbStatus: "error" })
        .where(eq(projectsTable.id, projectId));
      return;
    }

    const encrypted = encryptionService.encrypt(connectionString);
    await db
      .update(projectsTable)
      .set({ previewDbUrl: encrypted, previewDbStatus: "ready" })
      .where(eq(projectsTable.id, projectId));

    logger.info({ projectId }, "Preview DB provisioned successfully");
  } catch (err) {
    logger.error({ err, projectId }, "provisionPreviewDb failed");
    await db
      .update(projectsTable)
      .set({ previewDbStatus: "error" })
      .where(eq(projectsTable.id, projectId));
  }
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
