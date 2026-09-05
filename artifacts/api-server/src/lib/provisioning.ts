/**
 * Task #738 — Auto-provision container + Postgres per new project.
 *
 * When a project is created with `builderMode = 'agentic'` the API kicks off
 * a background job that:
 *   1. Creates the project's Cloudflare tenant runtime.
 *   2. Provisions a Neon Postgres allocation and stores the connection string as
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
 * Any other outcome (provider error or missing runtime/database configuration)
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
  ensurePreviewDatabaseAllocation,
  hasUnresolvedPreviewDatabaseAllocation,
  type PreviewDatabaseAllocationReceipt,
} from "./preview-database-allocation";
import {
  createContainer,
  ensureContainerLogTailer,
  isContainerLayerConfigured,
  tenantRuntimeProvider,
} from "./tenant-runtime";
import { encryptionService } from "./encryption";
import { publishProvisioningStep } from "./event-bus";
import { requiresDirectProjectDatabaseProvisioning } from "./zero-sealed-generation";
import { supportsExternalRuntimeLogTail } from "./tenant-runtime-provider";
import { acquireProjectLifecycleSession, registerProjectWorkController } from "./project-lifecycle";
import { ensureManualNeonAllocation } from "./manual-neon-allocation";
import { mayStartNeonAllocation } from "./neon-allocation-intent";

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

function humanizeTenantRuntimeError(raw: string | undefined): string {
  if (!raw) return "Could not reach the Cloudflare runtime. Please try again.";
  const excerpt = raw.slice(0, 120).replace(/\n/g, " ").trim();
  return `Cloudflare runtime error: ${excerpt}`;
}

/**
 * In-process set of project IDs whose provisioning job is currently running.
 * Prevents a duplicate background job from being kicked off if the user clicks
 * "Retry provisioning" twice in a row.
 */
const activeProvisioning = new Set<number>();
const provisioningControllers = new Map<number, AbortController>();

export function cancelLocalProjectProvisioning(projectId: number): boolean {
  const controller = provisioningControllers.get(projectId);
  if (!controller) return false;
  controller.abort();
  provisioningControllers.delete(projectId);
  return true;
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
  const lifecycleSession = await acquireProjectLifecycleSession(projectId);
  if (!lifecycleSession) {
    activeProvisioning.delete(projectId);
    return;
  }
  const controller = new AbortController();
  provisioningControllers.set(projectId, controller);
  const unregisterProjectWork = registerProjectWorkController(projectId, controller);

  const startedAt = new Date();

  try {
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), sql`${projectsTable.deletedAt} IS NULL`));
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

    const requiresDirectDatabase = requiresDirectProjectDatabaseProvisioning(process.env);

    // Legacy mode still requires both providers. Sealed mode provisions only
    // the credential-free runtime; its database arrives vault-to-vault later.
    const containerLayerOperational = await isContainerLayerConfigured();
    if (!containerLayerOperational || (requiresDirectDatabase && !process.env.NEON_API_KEY)) {
      const missing: string[] = [];
      if (!containerLayerOperational) missing.push("tenant runtime layer");
      if (requiresDirectDatabase && !process.env.NEON_API_KEY) missing.push("NEON_API_KEY");
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

      // Missing credentials are not provider absence evidence. Preserve every
      // stored runtime reference for governed retirement or configuration recovery.

      return;
    }

    // Step 1 — container (idempotent: skip if already present)
    let containerId = project.containerId;
    if (!containerId) {
      if (controller.signal.aborted || !(await lifecycleSession.assertActive())) return;
      await setStep(projectId, "create_container");
      let containerError: string | undefined;
      try {
        const info = await createContainer(projectId, project.stack, undefined, {
          servicePort: project.runtimePort,
        });
        if (controller.signal.aborted || !(await lifecycleSession.assertActive())) return;
        if (!info) {
          containerError = "Failed to create Cloudflare runtime for this project.";
        } else if ("error" in info) {
          containerError = humanizeTenantRuntimeError(info.error);
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
        containerError = humanizeTenantRuntimeError(raw);
      }
      if (containerError) {
        await markError(projectId, containerError, "create_container");
        return;
      }
      await completeStep(projectId, "create_container");
    }

    // The historical Fly tailer is not a universal runtime capability.
    // Cloudflare diagnostics flow through signed control surfaces instead.
    if (containerId && supportsExternalRuntimeLogTail(tenantRuntimeProvider)) {
      ensureContainerLogTailer(projectId, containerId);
    }

    if (!requiresDirectDatabase) {
      const durationMs = Date.now() - startedAt.getTime();
      recordCompletionDurationMs(durationMs);
      await db
        .update(projectsTable)
        .set({ provisioningStatus: "ready", provisioningError: null, provisioningStep: null })
        .where(eq(projectsTable.id, projectId));
      logger.info(
        { projectId, durationMs },
        "Sealed runtime provisioning complete; database capability remains vault-owned",
      );
      return;
    }

    // Step 2 - direct automatic and manual setup share the same durable intent.
    // A previous POST with a lost response is lookup-only, never another POST.
    if (controller.signal.aborted || !(await lifecycleSession.assertActive())) return;
    await setStep(projectId, "create_database");
    const observedDatabase = { ...project };
    const databaseFence = () =>
      and(
        eq(projectsTable.id, projectId),
        eq(projectsTable.ownerId, project.ownerId),
        sql`${projectsTable.deletedAt} IS NULL`,
        eq(projectsTable.dbProvider, observedDatabase.dbProvider),
        eq(projectsTable.dbStatus, observedDatabase.dbStatus),
        sql`${projectsTable.neonProjectId} IS NOT DISTINCT FROM ${observedDatabase.neonProjectId}`,
        sql`${projectsTable.dbConnectionId} IS NOT DISTINCT FROM ${observedDatabase.dbConnectionId}`,
      );
    const recordAllocation = async (id?: string): Promise<boolean> => {
      if (controller.signal.aborted || !(await lifecycleSession.assertActive())) return false;
      const values = {
        dbProvider: "postgres",
        dbStatus: "provisioning",
        ...(id ? { neonProjectId: id, dbConnectionId: id } : {}),
      };
      const changed = await db
        .update(projectsTable)
        .set(values)
        .where(databaseFence())
        .returning({ id: projectsTable.id });
      if (changed.length !== 1) return false;
      Object.assign(observedDatabase, values);
      return true;
    };
    const neon = await ensureManualNeonAllocation({
      project: observedDatabase,
      apiKey: process.env.NEON_API_KEY ?? "",
      assertActive: async () =>
        !controller.signal.aborted && (await lifecycleSession.assertActive()),
      store: {
        recordIntent: async () =>
          mayStartNeonAllocation(observedDatabase) && (await recordAllocation()),
        recordOwnership: (id) => recordAllocation(id),
      },
    });
    if (!neon) {
      await markError(
        projectId,
        "Database setup is not confirmed. Retry checks the existing allocation without creating another database. If configuration is unavailable, contact support.",
        "create_database",
      );
      return;
    }
    const { connectionString } = neon;
    await completeStep(projectId, "create_database");

    // Step 3 — connect and test (store DATABASE_URL secret)
    await setStep(projectId, "connect_and_test");

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
      if (controller.signal.aborted || !(await lifecycleSession.assertActive())) return;
      const connected = await db
        .update(projectsTable)
        .set({ dbStatus: "connected" })
        .where(databaseFence())
        .returning({ id: projectsTable.id });
      if (connected.length !== 1) throw new Error("neon_allocation_receipt_conflict");
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

    if (controller.signal.aborted || !(await lifecycleSession.assertActive())) return;
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
    unregisterProjectWork();
    if (provisioningControllers.get(projectId) === controller) {
      provisioningControllers.delete(projectId);
    }
    await lifecycleSession.release();
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

/** The project row owns the durable preview claim; retries only reconcile that claim. */
export async function provisionPreviewDb(projectId: number): Promise<void> {
  const lifecycleSession = await acquireProjectLifecycleSession(projectId);
  if (!lifecycleSession) return;
  const controller = new AbortController();
  const unregisterProjectWork = registerProjectWorkController(projectId, controller);
  try {
    const [project] = await db
      .select({
        id: projectsTable.id,
        ownerId: projectsTable.ownerId,
        name: projectsTable.name,
        previewDbStatus: projectsTable.previewDbStatus,
        previewDbUrl: projectsTable.previewDbUrl,
        previewDbAllocation: projectsTable.previewDbAllocation,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), sql`${projectsTable.deletedAt} IS NULL`));
    if (!project) return;
    const observed = { ...project };
    const state = () => ({
      status: observed.previewDbStatus,
      hasCredential: observed.previewDbUrl !== null,
      allocation: observed.previewDbAllocation,
    });
    if (
      observed.previewDbStatus === "ready" &&
      observed.previewDbUrl !== null &&
      !hasUnresolvedPreviewDatabaseAllocation(projectId, state())
    )
      return;
    const assertActive = async () =>
      !controller.signal.aborted && (await lifecycleSession.assertActive());
    const fence = (expected: unknown = observed.previewDbAllocation) =>
      and(
        eq(projectsTable.id, projectId),
        eq(projectsTable.ownerId, project.ownerId),
        sql`${projectsTable.deletedAt} IS NULL`,
        eq(projectsTable.previewDbStatus, observed.previewDbStatus),
        sql`${projectsTable.previewDbUrl} IS NOT DISTINCT FROM ${observed.previewDbUrl}`,
        sql`${projectsTable.previewDbAllocation} IS NOT DISTINCT FROM ${expected === null ? null : JSON.stringify(expected)}::jsonb`,
      );
    const recordReceipt = async (
      expected: PreviewDatabaseAllocationReceipt | null,
      next: PreviewDatabaseAllocationReceipt,
    ): Promise<boolean> => {
      if (!(await assertActive())) return false;
      const values = { previewDbAllocation: { ...next }, previewDbStatus: "provisioning" };
      const changed = await db
        .update(projectsTable)
        .set(values)
        .where(fence(expected))
        .returning({ id: projectsTable.id });
      if (changed.length !== 1) return false;
      Object.assign(observed, values);
      return true;
    };
    const material = await ensurePreviewDatabaseAllocation({
      projectId,
      name: project.name,
      state: state(),
      signal: controller.signal,
      assertActive,
      recordReceipt,
    });
    if (!material) {
      // A preflight failure does not spend a pristine attempt. An existing claim never resets.
      if (
        (observed.previewDbAllocation !== null || observed.previewDbStatus !== "none") &&
        (await assertActive())
      ) {
        await db.update(projectsTable).set({ previewDbStatus: "error" }).where(fence());
      }
      return;
    }
    if (!(await assertActive())) return;
    const encrypted = encryptionService.encrypt(material.connectionString);
    if (!(await assertActive())) return;
    await db
      .update(projectsTable)
      .set({ previewDbUrl: encrypted, previewDbStatus: "ready" })
      .where(fence(material.allocation))
      .returning({ id: projectsTable.id });
  } catch {
    // Keep the durable claim and any ownership receipt after every uncertain outcome.
    logger.warn({ projectId }, "Preview database provisioning remains unconfirmed");
  } finally {
    unregisterProjectWork();
    await lifecycleSession.release();
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
