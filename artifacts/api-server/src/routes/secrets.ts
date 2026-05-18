import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, secretsTable, secretAuditLogTable, type Secret } from "@workspace/db";
import {
  ListSecretsParams,
  ListSecretsResponse,
  CreateSecretParams,
  CreateSecretBody,
} from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService, maskValue } from "../lib/encryption";

// Environment mismatch: warn if a key labelled for one env is being used in another.
// This is informational only — we surface a warning flag in the response so the UI can show it.
function detectEnvMismatch(
  secretEnv: string,
  requestedEnv: string | undefined,
): string | null {
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
  action: "created" | "updated" | "deleted" | "accessed";
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

router.get(
  "/projects/:id/secrets",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
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
  },
);

router.post(
  "/projects/:id/secrets",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
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

    res.status(201).json(toEntry(row));
  },
);

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
    const [row] = await db
      .select()
      .from(secretsTable)
      .where(eq(secretsTable.id, secretId));
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
    const [existing] = await db
      .select()
      .from(secretsTable)
      .where(eq(secretsTable.id, secretId));
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

    res.json(toEntry(row));
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

export default router;
