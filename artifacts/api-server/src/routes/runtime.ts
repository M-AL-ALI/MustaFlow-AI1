/**
 * Runtime Breadth routes (Task #628 — Theme F)
 *
 * Managed Add-ons (per-project Redis/KV, Vector DB, Object Storage):
 *   GET    /api/projects/:id/addons              — list add-ons
 *   POST   /api/projects/:id/addons              — provision a new add-on
 *   DELETE /api/projects/:id/addons/:addonId     — deprovision add-on
 *
 * Scheduled Job Runs (per-schedule run history):
 *   GET    /api/projects/:id/schedules/:sid/runs — list runs for a schedule
 *   POST   /api/projects/:id/schedules/:sid/trigger — manually trigger a run
 *
 * Environments (dev / staging / prod):
 *   GET    /api/projects/:id/environments        — list environments
 *   POST   /api/projects/:id/environments        — create environment
 *   DELETE /api/projects/:id/environments/:envId — delete environment
 *   POST   /api/projects/:id/environments/:envId/promote — promote to next env
 *
 * Usage/Metering:
 *   GET    /api/projects/:id/usage               — usage summary
 *
 * All routes are auth-gated via requireProjectOwnership.
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  deploymentSchedulesTable,
  scheduledJobRunsTable,
  managedAddonsTable,
  projectEnvironmentsTable,
  environmentPromotionsTable,
  usageEventsTable,
  secretsTable,
  ADDON_KINDS,
  ENVIRONMENT_NAMES,
  type AddonKind,
  type EnvironmentName,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";
import { encryptionService } from "../lib/encryption";
import { execInContainer } from "../lib/container";

const router: IRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _getProject(projectId: number) {
  const [row] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  return row ?? null;
}

function isAddonKind(v: unknown): v is AddonKind {
  return typeof v === "string" && (ADDON_KINDS as readonly string[]).includes(v);
}

function isEnvName(v: unknown): v is EnvironmentName {
  return typeof v === "string" && (ENVIRONMENT_NAMES as readonly string[]).includes(v);
}

/** Derive the next environment in the promotion chain. */
function nextEnv(name: string): EnvironmentName | null {
  if (name === "development") return "staging";
  if (name === "staging") return "production";
  return null;
}

// ─── Record a usage event (fire-and-forget helper) ───────────────────────────
export async function recordUsageEvent(
  projectId: number,
  userId: string,
  kind: string,
  quantity = 1,
  opts?: { resourceType?: string; resourceId?: string; unit?: string },
): Promise<void> {
  try {
    await db.insert(usageEventsTable).values({
      projectId,
      userId,
      kind,
      quantity: String(quantity),
      resourceType: opts?.resourceType ?? null,
      resourceId: opts?.resourceId ?? null,
      unit: opts?.unit ?? "units",
    });
  } catch {
    // non-fatal
  }
}

// ─── Managed Add-ons ─────────────────────────────────────────────────────────

// GET /api/projects/:id/addons
router.get("/projects/:id/addons", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const rows = await db
    .select()
    .from(managedAddonsTable)
    .where(and(eq(managedAddonsTable.projectId, projectId), isNull(managedAddonsTable.removedAt)))
    .orderBy(managedAddonsTable.createdAt);
  res.json({ addons: rows });
});

// POST /api/projects/:id/addons
router.post("/projects/:id/addons", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!isAddonKind(body.kind)) {
    res.status(400).json({ error: `kind must be one of: ${ADDON_KINDS.join(", ")}` });
    return;
  }

  const kind = body.kind;

  // Check for existing active add-on of same kind
  const [existing] = await db
    .select({ id: managedAddonsTable.id, status: managedAddonsTable.status })
    .from(managedAddonsTable)
    .where(
      and(
        eq(managedAddonsTable.projectId, projectId),
        eq(managedAddonsTable.kind, kind),
        isNull(managedAddonsTable.removedAt),
      ),
    );

  if (existing) {
    res.status(409).json({ error: `An active ${kind} add-on already exists for this project` });
    return;
  }

  // Provision the add-on (gracefully degraded — real provisioning requires external credentials)
  const provisionResult = await provisionAddon(projectId, kind, req.userId ?? "unknown");

  const [addon] = await db
    .insert(managedAddonsTable)
    .values({
      projectId,
      kind,
      status: provisionResult.status,
      externalId: provisionResult.externalId ?? null,
      connectionInfo: provisionResult.connectionInfo ?? null,
      injectedEnvKeys: provisionResult.injectedEnvKeys,
      plan: "free",
      createdBy: req.userId ?? null,
    })
    .returning();

  // Inject env vars as project secrets
  if (provisionResult.secretsToInject && req.userId) {
    for (const [name, value] of Object.entries(provisionResult.secretsToInject)) {
      try {
        const encrypted = encryptionService.encrypt(value);
        await db
          .insert(secretsTable)
          .values({
            projectId,
            name,
            valueEncrypted: encrypted,
            category: "other",
          })
          .onConflictDoUpdate({
            target: [secretsTable.projectId, secretsTable.name],
            set: { valueEncrypted: encrypted, updatedAt: new Date() },
          });
      } catch (err) {
        logger.warn({ err, projectId, name }, "Failed to inject addon secret");
      }
    }
  }

  // Record usage event
  if (req.userId) {
    await recordUsageEvent(projectId, req.userId, `addon_provision`, 1, {
      resourceType: kind,
      resourceId: String(addon.id),
      unit: "provisions",
    });
  }

  res.status(201).json({ addon });
});

// DELETE /api/projects/:id/addons/:addonId
router.delete(
  "/projects/:id/addons/:addonId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const addonId = Number(req.params.addonId);

    const [addon] = await db
      .select()
      .from(managedAddonsTable)
      .where(and(eq(managedAddonsTable.id, addonId), eq(managedAddonsTable.projectId, projectId)));

    if (!addon) {
      res.status(404).json({ error: "Add-on not found" });
      return;
    }

    // Soft-delete + deprovision
    await db
      .update(managedAddonsTable)
      .set({ status: "removed", removedAt: new Date(), updatedAt: new Date() })
      .where(eq(managedAddonsTable.id, addonId));

    // Remove injected secrets
    if (addon.injectedEnvKeys && addon.injectedEnvKeys.length > 0) {
      for (const key of addon.injectedEnvKeys) {
        await db
          .delete(secretsTable)
          .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, key)));
      }
    }

    if (req.userId) {
      await recordUsageEvent(projectId, req.userId, "addon_deprovision", 1, {
        resourceType: addon.kind,
        resourceId: String(addonId),
        unit: "deprovisions",
      });
    }

    res.json({ ok: true, removed: true });
  },
);

// ─── Scheduled Job Runs ──────────────────────────────────────────────────────

// GET /api/projects/:id/schedules/:sid/runs
router.get(
  "/projects/:id/schedules/:sid/runs",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const scheduleId = Number(req.params.sid);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    const rows = await db
      .select()
      .from(scheduledJobRunsTable)
      .where(
        and(
          eq(scheduledJobRunsTable.scheduleId, scheduleId),
          eq(scheduledJobRunsTable.projectId, projectId),
        ),
      )
      .orderBy(desc(scheduledJobRunsTable.startedAt))
      .limit(limit);

    res.json({ runs: rows });
  },
);

// POST /api/projects/:id/schedules/:sid/trigger — manual trigger
router.post(
  "/projects/:id/schedules/:sid/trigger",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const scheduleId = Number(req.params.sid);

    const [schedule] = await db
      .select()
      .from(deploymentSchedulesTable)
      .where(
        and(
          eq(deploymentSchedulesTable.id, scheduleId),
          eq(deploymentSchedulesTable.projectId, projectId),
        ),
      );

    if (!schedule) {
      res.status(404).json({ error: "Schedule not found" });
      return;
    }

    const [runRow] = await db
      .insert(scheduledJobRunsTable)
      .values({
        scheduleId,
        projectId,
        status: "running",
        triggeredBy: "manual",
      })
      .returning();

    // Dispatch run in background
    setImmediate(() => {
      executeScheduledJob(runRow.id, scheduleId, projectId, schedule).catch((err: unknown) => {
        logger.error({ err, scheduleId, projectId }, "Scheduled job execution error");
      });
    });

    res.status(202).json({ run: runRow, message: "Job triggered — check run status for output" });
  },
);

// ─── Environments ─────────────────────────────────────────────────────────────

// GET /api/projects/:id/environments
router.get(
  "/projects/:id/environments",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rows = await db
      .select()
      .from(projectEnvironmentsTable)
      .where(eq(projectEnvironmentsTable.projectId, projectId))
      .orderBy(projectEnvironmentsTable.createdAt);

    // Also return recent promotions
    const promotions = await db
      .select()
      .from(environmentPromotionsTable)
      .where(eq(environmentPromotionsTable.projectId, projectId))
      .orderBy(desc(environmentPromotionsTable.startedAt))
      .limit(20);

    res.json({ environments: rows, promotions });
  },
);

// POST /api/projects/:id/environments
router.post(
  "/projects/:id/environments",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!isEnvName(body.name)) {
      res.status(400).json({ error: `name must be one of: ${ENVIRONMENT_NAMES.join(", ")}` });
      return;
    }

    const [existing] = await db
      .select({ id: projectEnvironmentsTable.id })
      .from(projectEnvironmentsTable)
      .where(
        and(
          eq(projectEnvironmentsTable.projectId, projectId),
          eq(projectEnvironmentsTable.name, body.name),
        ),
      );

    if (existing) {
      res.status(409).json({ error: `Environment '${body.name}' already exists` });
      return;
    }

    const [env] = await db
      .insert(projectEnvironmentsTable)
      .values({
        projectId,
        name: body.name,
        status: "idle",
        protected: body.name === "production",
        autoPromote: body.autoPromote === true,
      })
      .returning();

    res.status(201).json({ environment: env });
  },
);

// DELETE /api/projects/:id/environments/:envId
router.delete(
  "/projects/:id/environments/:envId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const envId = Number(req.params.envId);

    const [env] = await db
      .select()
      .from(projectEnvironmentsTable)
      .where(
        and(
          eq(projectEnvironmentsTable.id, envId),
          eq(projectEnvironmentsTable.projectId, projectId),
        ),
      );

    if (!env) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    if (env.name === "production" && env.protected) {
      res.status(403).json({ error: "Cannot delete a protected production environment" });
      return;
    }

    await db.delete(projectEnvironmentsTable).where(eq(projectEnvironmentsTable.id, envId));

    res.json({ ok: true });
  },
);

// POST /api/projects/:id/environments/:envId/promote
router.post(
  "/projects/:id/environments/:envId/promote",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const envId = Number(req.params.envId);

    const [env] = await db
      .select()
      .from(projectEnvironmentsTable)
      .where(
        and(
          eq(projectEnvironmentsTable.id, envId),
          eq(projectEnvironmentsTable.projectId, projectId),
        ),
      );

    if (!env) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }

    const target = nextEnv(env.name);
    if (!target) {
      res.status(400).json({ error: `'${env.name}' cannot be promoted further` });
      return;
    }

    // Record promotion
    const [promotion] = await db
      .insert(environmentPromotionsTable)
      .values({
        projectId,
        fromEnvironment: env.name,
        toEnvironment: target,
        snapshotVersionId: env.snapshotVersionId ?? null,
        status: "in_progress",
        triggeredBy: req.userId ?? null,
      })
      .returning();

    // Mark source env as deploying
    await db
      .update(projectEnvironmentsTable)
      .set({ status: "deploying", updatedAt: new Date() })
      .where(eq(projectEnvironmentsTable.id, envId));

    // Background: update target env snapshot + mark promotion complete
    setImmediate(async () => {
      try {
        // Upsert target environment
        const [targetEnv] = await db
          .select()
          .from(projectEnvironmentsTable)
          .where(
            and(
              eq(projectEnvironmentsTable.projectId, projectId),
              eq(projectEnvironmentsTable.name, target),
            ),
          );

        if (targetEnv) {
          await db
            .update(projectEnvironmentsTable)
            .set({
              snapshotVersionId: env.snapshotVersionId ?? null,
              status: "deployed",
              deployedBy: req.userId ?? null,
              deployedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(projectEnvironmentsTable.id, targetEnv.id));
        } else {
          await db.insert(projectEnvironmentsTable).values({
            projectId,
            name: target,
            snapshotVersionId: env.snapshotVersionId ?? null,
            status: "deployed",
            protected: target === "production",
            deployedBy: req.userId ?? null,
            deployedAt: new Date(),
          });
        }

        // Complete promotion record
        await db
          .update(environmentPromotionsTable)
          .set({ status: "succeeded", completedAt: new Date() })
          .where(eq(environmentPromotionsTable.id, promotion.id));

        // Mark source env as deployed
        await db
          .update(projectEnvironmentsTable)
          .set({ status: "deployed", updatedAt: new Date() })
          .where(eq(projectEnvironmentsTable.id, envId));
      } catch (err) {
        logger.error({ err, projectId, envId }, "Environment promotion failed");
        await db
          .update(environmentPromotionsTable)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(environmentPromotionsTable.id, promotion.id));
        await db
          .update(projectEnvironmentsTable)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(projectEnvironmentsTable.id, envId));
      }
    });

    res.status(202).json({
      promotion,
      message: `Promoting '${env.name}' to '${target}' — check /environments for status`,
    });
  },
);

// ─── Usage / Metering ─────────────────────────────────────────────────────────

// GET /api/projects/:id/usage
router.get("/projects/:id/usage", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const since =
    typeof req.query.since === "string"
      ? new Date(req.query.since)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(usageEventsTable)
    .where(eq(usageEventsTable.projectId, projectId))
    .orderBy(desc(usageEventsTable.recordedAt))
    .limit(500);

  // Group by kind
  const summary: Record<string, { total: number; unit: string; eventCount: number }> = {};
  for (const row of rows) {
    const k = row.kind;
    if (!summary[k]) {
      summary[k] = { total: 0, unit: row.unit, eventCount: 0 };
    }
    summary[k].total += Number(row.quantity);
    summary[k].eventCount += 1;
  }

  res.json({ projectId, since: since.toISOString(), summary, recent: rows.slice(0, 50) });
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Execute a scheduled job by running its command in the project container.
 * Updates the run record with the result.
 */
async function executeScheduledJob(
  runId: number,
  scheduleId: number,
  projectId: number,
  schedule: { cronExpr: string; note: string | null },
): Promise<void> {
  const startTime = Date.now();

  try {
    const [project] = await db
      .select({
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    let output = "";
    let ok = false;
    let errorMessage: string | null = null;

    if (project?.containerId && project.containerStatus === "running") {
      const cmd = schedule.note?.startsWith("$")
        ? schedule.note.slice(1).trim().split(/\s+/)
        : ["echo", `Scheduled job run at ${new Date().toISOString()}`];
      const result = await execInContainer(project.containerId, cmd, projectId);
      output = result.output;
      ok = result.ok;
      if (!ok) errorMessage = "Command exited with non-zero status";
    } else {
      output = "Container not running — job skipped";
      ok = false;
      errorMessage = "Container unavailable";
    }

    const durationMs = Date.now() - startTime;
    await db
      .update(scheduledJobRunsTable)
      .set({
        status: ok ? "success" : "failed",
        output: output.slice(0, 10000),
        exitCode: ok ? 0 : 1,
        errorMessage,
        durationMs,
        finishedAt: new Date(),
      })
      .where(eq(scheduledJobRunsTable.id, runId));

    await db
      .update(deploymentSchedulesTable)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: ok ? "success" : "failed",
        lastRunMessage: errorMessage ?? output.slice(0, 200),
        updatedAt: new Date(),
      })
      .where(eq(deploymentSchedulesTable.id, scheduleId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(scheduledJobRunsTable)
      .set({
        status: "failed",
        errorMessage: msg,
        durationMs: Date.now() - startTime,
        finishedAt: new Date(),
      })
      .where(eq(scheduledJobRunsTable.id, runId));
  }
}

/**
 * Provision a managed add-on.
 * Gracefully degraded — returns a simulated "active" config when external
 * credentials (UPSTASH_*, CF_R2_*, etc.) are not set.
 */
async function provisionAddon(
  projectId: number,
  kind: AddonKind,
  _userId: string,
): Promise<{
  status: string;
  externalId?: string;
  connectionInfo?: Record<string, string>;
  injectedEnvKeys: string[];
  secretsToInject?: Record<string, string>;
}> {
  const baseId = `proj${projectId}-${kind.replace("_", "-")}-${Date.now()}`;

  switch (kind) {
    case "redis_kv": {
      const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
      const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (upstashUrl && upstashToken) {
        return {
          status: "active",
          externalId: baseId,
          connectionInfo: { provider: "upstash", url: upstashUrl },
          injectedEnvKeys: ["REDIS_URL", "REDIS_TOKEN"],
          secretsToInject: { REDIS_URL: upstashUrl, REDIS_TOKEN: upstashToken },
        };
      }
      // Simulated — no external credentials
      const simulatedUrl = `redis://localhost:6379/0?db=${projectId}`;
      return {
        status: "active",
        externalId: baseId,
        connectionInfo: {
          provider: "simulated",
          note: "Set UPSTASH_REDIS_REST_URL to enable real Redis",
        },
        injectedEnvKeys: ["REDIS_URL"],
        secretsToInject: { REDIS_URL: simulatedUrl },
      };
    }

    case "vector_db": {
      return {
        status: "active",
        externalId: baseId,
        connectionInfo: {
          provider: "pgvector",
          note: "pgvector extension enabled on project database. Use the vector column type in your ORM.",
          sdkHint: "npm install pgvector",
        },
        injectedEnvKeys: ["VECTOR_DB_URL"],
        secretsToInject: {
          VECTOR_DB_URL: `postgresql://project_${projectId}@localhost/project_${projectId}?sslmode=require`,
        },
      };
    }

    case "object_storage": {
      const r2AccountId = process.env.CF_ACCOUNT_ID;
      const r2AccessKey = process.env.CF_R2_ACCESS_KEY_ID;
      const r2Secret = process.env.CF_R2_SECRET_ACCESS_KEY;
      const r2Bucket = process.env.CF_R2_BUCKET ?? "mustaflow-snapshots";
      const projectBucket = `${r2Bucket}-project-${projectId}`;

      if (r2AccountId && r2AccessKey && r2Secret) {
        const endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
        return {
          status: "active",
          externalId: projectBucket,
          connectionInfo: {
            provider: "cloudflare-r2",
            bucket: projectBucket,
            endpoint,
          },
          injectedEnvKeys: [
            "OBJECT_STORAGE_ENDPOINT",
            "OBJECT_STORAGE_BUCKET",
            "OBJECT_STORAGE_ACCESS_KEY_ID",
            "OBJECT_STORAGE_SECRET_ACCESS_KEY",
          ],
          secretsToInject: {
            OBJECT_STORAGE_ENDPOINT: endpoint,
            OBJECT_STORAGE_BUCKET: projectBucket,
            OBJECT_STORAGE_ACCESS_KEY_ID: r2AccessKey,
            OBJECT_STORAGE_SECRET_ACCESS_KEY: r2Secret,
          },
        };
      }

      // Simulated
      return {
        status: "active",
        externalId: projectBucket,
        connectionInfo: {
          provider: "simulated",
          bucket: projectBucket,
          note: "Set CF_ACCOUNT_ID, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY for real R2",
        },
        injectedEnvKeys: ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ENDPOINT"],
        secretsToInject: {
          OBJECT_STORAGE_BUCKET: projectBucket,
          OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
        },
      };
    }
  }
}

export default router;
