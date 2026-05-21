import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  secretsTable,
  secretAuditLogTable,
  projectFilesTable,
  projectsTable,
  containerLogsTable,
  agentTasksTable,
  taskEventsTable,
  type Secret,
} from "@workspace/db";
import {
  ListSecretsParams,
  ListSecretsResponse,
  CreateSecretParams,
  CreateSecretBody,
} from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService, maskValue } from "../lib/encryption";
import { writeKnowledge } from "../lib/knowledge";
import { restartContainerWithSecrets, execInContainer } from "../lib/container";
import { logger } from "../lib/logger";
import { publishTaskEvent } from "../lib/event-bus";

/**
 * Load all secrets for a project as decrypted { name: value } pairs and
 * fire a best-effort container restart with the latest env.
 * Never throws — failures are swallowed so secret mutations always succeed.
 */
async function triggerContainerSecretRefresh(projectId: number): Promise<void> {
  try {
    const rows = await db
      .select({ name: secretsTable.name, valueEncrypted: secretsTable.valueEncrypted })
      .from(secretsTable)
      .where(eq(secretsTable.projectId, projectId));

    const envVars: Record<string, string> = {};
    for (const row of rows) {
      try {
        envVars[row.name] = encryptionService.decrypt(row.valueEncrypted);
      } catch {
        // skip individual decrypt failures
      }
    }

    await restartContainerWithSecrets(projectId, envVars);
  } catch {
    // best-effort — never fail the main secret operation
  }
}

/**
 * Secret names that indicate a database connection string.
 * When any of these are saved or updated, we attempt to run Drizzle migrations
 * if the project has a running container and Drizzle config files.
 */
const DB_SECRET_NAME_PATTERNS = [
  /^DATABASE_URL$/i,
  /^DB_URL$/i,
  /^POSTGRES(?:_URL|_CONNECTION_STRING|QL_URL)?$/i,
  /^MYSQL_URL$/i,
  /^MONGODB_URI$/i,
  /^REDIS_URL$/i,
  /^DATABASE_CONNECTION_STRING$/i,
  /^NEON_DATABASE_URL$/i,
  /^SUPABASE_DB_URL$/i,
];

function isDbSecret(name: string): boolean {
  return DB_SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Write a task event to the most recent task for this project (best-effort).
 * Also publishes to the in-memory event bus so any live SSE subscriber picks it up.
 * Falls back silently if no task exists or the DB write fails.
 */
async function emitMigrationTaskEvent(
  projectId: number,
  eventType: string,
  message: string,
): Promise<void> {
  try {
    const [latestTask] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(eq(agentTasksTable.projectId, projectId))
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(1);

    if (!latestTask) return;

    const [row] = await db
      .insert(taskEventsTable)
      .values({ taskId: latestTask.id, eventType, message })
      .returning();

    if (row) {
      publishTaskEvent({
        id: row.id,
        taskId: row.taskId,
        eventType: row.eventType,
        message: row.message,
        filePath: row.filePath ?? null,
        createdAt: row.createdAt,
      });
    }
  } catch {
    // best-effort — never block the migration path
  }
}

/**
 * After a database-related secret is saved/updated, check whether the project
 * has Drizzle config files and a running container. If so, run migrations
 * automatically so the new DATABASE_URL takes effect immediately.
 *
 * Best-effort — never throws; the secret save always succeeds.
 */
async function triggerMigrationsAfterDbSecretChange(
  projectId: number,
  secretName: string,
): Promise<void> {
  if (!isDbSecret(secretName)) return;

  try {
    // Check for Drizzle config files in the project
    const allProjectFiles = await db
      .select({ path: projectFilesTable.path, content: projectFilesTable.content })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    const hasDrizzleFiles = allProjectFiles.some(
      (f) =>
        f.path.startsWith("drizzle/") ||
        f.path === "drizzle.config.ts" ||
        f.path === "drizzle.config.js" ||
        f.path === "drizzle.config.mjs" ||
        f.path === "drizzle.config.cjs",
    );

    if (!hasDrizzleFiles) return;

    // Check for a running container
    const [project] = await db
      .select({
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project?.containerId || project.containerStatus !== "running") {
      const skipMsg = `Secret "${secretName}" updated — container is not running, migrations skipped. Start a container to apply schema changes.`;
      try {
        await db
          .insert(containerLogsTable)
          .values({ projectId, level: "system", message: skipMsg });
      } catch {
        /* non-fatal */
      }
      void emitMigrationTaskEvent(projectId, "narration", skipMsg);
      return;
    }

    const machineId = project.containerId;
    const startMsg = `Secret "${secretName}" updated — running database migrations automatically…`;

    try {
      await db.insert(containerLogsTable).values({ projectId, level: "system", message: startMsg });
    } catch {
      /* non-fatal */
    }
    void emitMigrationTaskEvent(projectId, "narration", startMsg);

    // Sync latest files so the container sees the current schema.
    // Note: triggerContainerSecretRefresh (called just before this) initiates a
    // machine restart. We sync files and run migrations independently — the new
    // DATABASE_URL env var is already baked into the machine config at this point
    // because restartContainerWithSecrets calls updateContainerEnv before restarting.
    const { syncFilesToContainer } = await import("../lib/container");
    await syncFilesToContainer(machineId, projectId, allProjectFiles);

    // Install dependencies if package.json is present (so drizzle-kit is available)
    const hasPackageJson = allProjectFiles.some((f) => f.path === "package.json");
    if (hasPackageJson) {
      await execInContainer(
        machineId,
        ["npm", "install", "--prefer-offline", "--no-audit"],
        projectId,
      );
    }

    // Choose migration command: prefer db:push script, otherwise drizzle-kit migrate
    let migrationCmd: string[];
    try {
      const pkgFile = allProjectFiles.find((f) => f.path === "package.json");
      const pkgJson = pkgFile
        ? (JSON.parse(pkgFile.content) as { scripts?: Record<string, string> })
        : null;
      migrationCmd =
        pkgJson?.scripts?.["db:push"] != null
          ? ["npm", "run", "db:push"]
          : ["npx", "drizzle-kit", "migrate"];
    } catch {
      migrationCmd = ["npx", "drizzle-kit", "migrate"];
    }

    void emitMigrationTaskEvent(
      projectId,
      "narration",
      `Running database migrations: ${migrationCmd.join(" ")}…`,
    );

    const migrationResult = await execInContainer(machineId, migrationCmd, projectId);

    if (migrationResult.ok) {
      logger.info({ projectId, secretName }, "Auto-migration after DB secret change succeeded");
      const successMsg = `Database migrations applied successfully after "${secretName}" update.`;
      try {
        await db
          .insert(containerLogsTable)
          .values({ projectId, level: "system", message: successMsg });
      } catch {
        /* non-fatal */
      }
      void emitMigrationTaskEvent(projectId, "narration", successMsg);
    } else {
      logger.warn(
        { projectId, secretName, output: migrationResult.output },
        "Auto-migration after DB secret change failed",
      );
      const failMsg = `Database migration failed after "${secretName}" update: ${migrationResult.output.slice(0, 400)}`;
      try {
        await db
          .insert(containerLogsTable)
          .values({ projectId, level: "system", message: failMsg });
      } catch {
        /* non-fatal */
      }
      void emitMigrationTaskEvent(projectId, "failed", failMsg);
    }
  } catch (err) {
    // Best-effort — never propagate to the caller
    logger.warn({ err, projectId, secretName }, "triggerMigrationsAfterDbSecretChange threw");
  }
}

// Environment mismatch: warn if a key labelled for one env is being used in another.
// This is informational only — we surface a warning flag in the response so the UI can show it.
function detectEnvMismatch(secretEnv: string, requestedEnv: string | undefined): string | null {
  if (!requestedEnv) return null;
  if (secretEnv === requestedEnv) return null;
  if (secretEnv === "production" && requestedEnv !== "production") {
    return `Production key used outside production (current context: ${requestedEnv}).`;
  }
  if (secretEnv !== "production" && requestedEnv === "production") {
    return `Non-production key (${secretEnv}) is being referenced in a production context.`;
  }
  return null;
}

function toEntry(row: Secret, contextEnv?: string) {
  const envWarning = detectEnvMismatch(row.environment, contextEnv);
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    masked: maskValue(encryptionService.decrypt(row.valueEncrypted)),
    environment: row.environment,
    category: row.category,
    verificationStatus: row.verificationStatus,
    envWarning: envWarning ?? null,
    encryptionNote: encryptionService.isDevelopmentOnly
      ? "DEV: values stored without encryption. Do not use real production secrets."
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

async function writeAuditLog(opts: {
  projectId: number;
  secretId: number | null;
  secretName: string;
  action: "created" | "updated" | "deleted" | "accessed" | "verified" | "verification_failed";
  actorId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(secretAuditLogTable).values({
      projectId: opts.projectId,
      secretId: opts.secretId,
      secretName: opts.secretName,
      action: opts.action,
      actorId: opts.actorId,
      metadata: opts.metadata ?? null,
    });
  } catch {
    // best-effort — never fail the main operation for an audit log write
  }
}

const router: IRouter = Router();

router.get("/projects/:id/secrets", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = ListSecretsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const contextEnv = typeof req.query.env === "string" ? req.query.env : undefined;
  const rows = await db
    .select()
    .from(secretsTable)
    .where(eq(secretsTable.projectId, params.data.id))
    .orderBy(desc(secretsTable.createdAt));
  res.json(ListSecretsResponse.parse(rows.map((r) => toEntry(r, contextEnv))));
});

router.post("/projects/:id/secrets", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = CreateSecretParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateSecretBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const encrypted = encryptionService.encrypt(parsed.data.value);

  const [row] = await db
    .insert(secretsTable)
    .values({
      projectId: params.data.id,
      name: parsed.data.name,
      valueEncrypted: encrypted,
      environment: parsed.data.environment ?? "development",
      category: (parsed.data as { category?: string }).category ?? "other",
    })
    .returning();
  if (!row) {
    res.status(500).json({ error: "Failed to save secret" });
    return;
  }

  void writeAuditLog({
    projectId: params.data.id,
    secretId: row.id,
    secretName: parsed.data.name,
    action: "created",
    actorId: req.userId ?? "unknown",
    metadata: { environment: row.environment, category: row.category },
  });

  void writeKnowledge({
    title: `Secret ${parsed.data.name} added`,
    content: `Secret "${parsed.data.name}" was added to the ${row.environment} environment.`,
    type: "secret_change",
    category: "diagnostic",
    severity: "info",
    projectId: params.data.id,
    userId: req.userId,
  });

  // Restart container (if running) so the new secret is available immediately
  void triggerContainerSecretRefresh(params.data.id);

  // If this is a database URL secret and the project has Drizzle files + a running
  // container, auto-run migrations so the new connection string takes effect immediately.
  void triggerMigrationsAfterDbSecretChange(params.data.id, parsed.data.name);

  res.status(201).json(toEntry(row));
});

router.delete(
  "/projects/:id/secrets/:secretId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const secretId = Number(req.params.secretId);
    if (!Number.isFinite(secretId)) {
      res.status(400).json({ error: "Invalid secret id" });
      return;
    }
    const [row] = await db.select().from(secretsTable).where(eq(secretsTable.id, secretId));
    if (!row || row.projectId !== projectId) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await db.delete(secretsTable).where(eq(secretsTable.id, secretId));

    void writeAuditLog({
      projectId,
      secretId,
      secretName: row.name,
      action: "deleted",
      actorId: req.userId ?? "unknown",
      metadata: { environment: row.environment },
    });

    void writeKnowledge({
      title: `Secret ${row.name} deleted`,
      content: `Secret "${row.name}" was removed from the ${row.environment} environment.`,
      type: "secret_change",
      category: "diagnostic",
      severity: "info",
      projectId,
      userId: req.userId,
    });

    // Restart container (if running) so the removed secret is no longer available
    void triggerContainerSecretRefresh(projectId);

    res.json({ deleted: true, id: secretId });
  },
);

router.patch(
  "/projects/:id/secrets/:secretId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const secretId = Number(req.params.secretId);
    if (!Number.isFinite(secretId)) {
      res.status(400).json({ error: "Invalid secret id" });
      return;
    }
    const [existing] = await db.select().from(secretsTable).where(eq(secretsTable.id, secretId));
    if (!existing || existing.projectId !== projectId) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const body = req.body as {
      value?: string;
      environment?: string;
      category?: string;
      verificationStatus?: string;
    };
    const updates: Partial<{
      valueEncrypted: string;
      environment: string;
      category: string;
      verificationStatus: string;
      updatedAt: ReturnType<typeof sql>;
    }> = { updatedAt: sql`now()` };

    if (body.value) updates.valueEncrypted = encryptionService.encrypt(body.value);
    if (body.environment) updates.environment = body.environment;
    if (body.category) updates.category = body.category;
    if (body.verificationStatus) updates.verificationStatus = body.verificationStatus;

    const [row] = await db
      .update(secretsTable)
      .set(updates)
      .where(eq(secretsTable.id, secretId))
      .returning();
    if (!row) {
      res.status(500).json({ error: "Failed to update secret" });
      return;
    }

    void writeAuditLog({
      projectId,
      secretId,
      secretName: row.name,
      action: "updated",
      actorId: req.userId ?? "unknown",
      metadata: { fields: Object.keys(body) },
    });

    const changedFields = Object.keys(body)
      .filter((k) => k !== "value")
      .join(", ");
    void writeKnowledge({
      title: `Secret ${row.name} updated`,
      content: `Secret "${row.name}" in the ${row.environment} environment was updated${changedFields ? ` (${changedFields} changed)` : ""}.`,
      type: "secret_change",
      category: "diagnostic",
      severity: "info",
      projectId,
      userId: req.userId,
    });

    // Restart container (if running) so the updated secret value is picked up
    void triggerContainerSecretRefresh(projectId);

    // If this is a database URL secret and the value changed, auto-run migrations
    // so the new connection string takes effect immediately without a rebuild.
    if (body.value) {
      void triggerMigrationsAfterDbSecretChange(projectId, row.name);
    }

    res.json(toEntry(row));
  },
);

// POST /api/projects/:id/secrets/:secretId/verify
// Attempt automated verification of a secret. Supported: OpenAI keys, Stripe key format.
router.post(
  "/projects/:id/secrets/:secretId/verify",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const secretId = Number(req.params.secretId);
    if (!Number.isFinite(secretId)) {
      res.status(400).json({ error: "Invalid secret id" });
      return;
    }

    const [row] = await db.select().from(secretsTable).where(eq(secretsTable.id, secretId));

    if (!row || row.projectId !== projectId) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    let plaintext: string;
    try {
      plaintext = encryptionService.decrypt(row.valueEncrypted);
    } catch {
      res.status(422).json({ error: "Could not decrypt secret for verification." });
      return;
    }

    let status: "verified" | "verification_failed" | "manual_required" = "manual_required";
    let message =
      "Automatic verification is not supported for this secret type. Please verify manually.";

    const nameLower = row.name.toLowerCase();

    if (nameLower === "eas_access_token") {
      try {
        const easRes = await fetch("https://api.expo.dev/v2/viewer", {
          headers: { Authorization: `Bearer ${plaintext}`, "Content-Type": "application/json" },
        });
        if (easRes.ok) {
          const body = (await easRes.json()) as { data?: { username?: string } };
          const username = body?.data?.username;
          status = "verified";
          message = username
            ? `EAS token is valid. Authenticated as "${username}".`
            : "EAS token is valid and active.";
        } else if (easRes.status === 401 || easRes.status === 403) {
          status = "verification_failed";
          message = "EAS token is invalid or expired (HTTP " + easRes.status + ").";
        } else {
          status = "manual_required";
          message = `EAS API returned HTTP ${easRes.status} — please verify manually.`;
        }
      } catch {
        status = "manual_required";
        message = "Could not reach EAS API to verify — check network connectivity.";
      }
    } else if (nameLower.includes("openai") || plaintext.startsWith("sk-")) {
      try {
        const oRes = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${plaintext}` },
        });
        if (oRes.ok) {
          status = "verified";
          message = "OpenAI key is valid and active.";
        } else if (oRes.status === 401) {
          status = "verification_failed";
          message = "OpenAI key is invalid or revoked (HTTP 401).";
        } else {
          status = "manual_required";
          message = `OpenAI returned HTTP ${oRes.status} — please verify manually.`;
        }
      } catch {
        status = "manual_required";
        message = "Could not reach OpenAI to verify — check network connectivity.";
      }
    } else if (
      nameLower.includes("stripe") ||
      plaintext.startsWith("sk_live_") ||
      plaintext.startsWith("sk_test_") ||
      plaintext.startsWith("rk_live_") ||
      plaintext.startsWith("rk_test_")
    ) {
      const isValidFormat = /^(sk|rk)_(live|test)_[a-zA-Z0-9]{20,}$/.test(plaintext);
      if (isValidFormat) {
        status = "verified";
        message = "Stripe key format is valid. (Live API call not performed.)";
      } else {
        status = "verification_failed";
        message =
          "This does not match the expected Stripe key format (sk_live_... or sk_test_...).";
      }
    }

    const [updated] = await db
      .update(secretsTable)
      .set({ verificationStatus: status, updatedAt: sql`now()` })
      .where(eq(secretsTable.id, secretId))
      .returning();

    void writeAuditLog({
      projectId,
      secretId,
      secretName: row.name,
      action:
        status === "verified"
          ? "verified"
          : status === "verification_failed"
            ? "verification_failed"
            : "accessed",
      actorId: req.userId ?? "unknown",
      metadata: { status, message },
    });

    res.json({
      secretId,
      status,
      message,
      entry: updated ? toEntry(updated) : null,
    });
  },
);

router.get(
  "/projects/:id/secrets/audit",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const rows = await db
      .select()
      .from(secretAuditLogTable)
      .where(eq(secretAuditLogTable.projectId, projectId))
      .orderBy(desc(secretAuditLogTable.createdAt))
      .limit(100);
    res.json(rows);
  },
);

router.get(
  "/projects/:id/secrets/:secretId/audit-log",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const secretId = Number(req.params.secretId);
    if (!Number.isFinite(projectId) || !Number.isFinite(secretId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Confirm the secret belongs to this project before returning any audit data
    const [secret] = await db
      .select({ id: secretsTable.id })
      .from(secretsTable)
      .where(and(eq(secretsTable.id, secretId), eq(secretsTable.projectId, projectId)));

    if (!secret) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const rawLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

    // Scope the query to both secretId AND projectId so orphaned rows from
    // other projects are never returned even if secretIds collide.
    const rows = await db
      .select()
      .from(secretAuditLogTable)
      .where(
        and(
          eq(secretAuditLogTable.secretId, secretId),
          eq(secretAuditLogTable.projectId, projectId),
        ),
      )
      .orderBy(desc(secretAuditLogTable.createdAt))
      .limit(limit);

    res.json(
      rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        secretId: r.secretId,
        secretName: r.secretName,
        action: r.action,
        actorId: r.actorId,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
    );
  },
);

export default router;
