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
import { writeKnowledge } from "../lib/knowledge";

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

    void writeKnowledge({
      title: `Secret ${parsed.data.name} added`,
      content: `Secret "${parsed.data.name}" was added to the ${row.environment} environment.`,
      type: "secret_change",
      category: "diagnostic",
      severity: "info",
      projectId: params.data.id,
      userId: req.userId,
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

    void writeKnowledge({
      title: `Secret ${row.name} deleted`,
      content: `Secret "${row.name}" was removed from the ${row.environment} environment.`,
      type: "secret_change",
      category: "diagnostic",
      severity: "info",
      projectId,
      userId: req.userId,
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

    const changedFields = Object.keys(body).filter((k) => k !== "value").join(", ");
    void writeKnowledge({
      title: `Secret ${row.name} updated`,
      content: `Secret "${row.name}" in the ${row.environment} environment was updated${changedFields ? ` (${changedFields} changed)` : ""}.`,
      type: "secret_change",
      category: "diagnostic",
      severity: "info",
      projectId,
      userId: req.userId,
    });

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

    const [row] = await db
      .select()
      .from(secretsTable)
      .where(eq(secretsTable.id, secretId));

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
    let message = "Automatic verification is not supported for this secret type. Please verify manually.";

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
        message = "This does not match the expected Stripe key format (sk_live_... or sk_test_...).";
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
      action: status === "verified" ? "verified" : (status === "verification_failed" ? "verification_failed" : "accessed"),
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

export default router;
