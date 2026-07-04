/**
 * Orax Desktop — Phase 2B backend routes.
 *
 * Covers: host registration, host list/get/patch/revoke,
 * pairing code create/redeem/delete, and REST heartbeat.
 *
 * All routes require a valid Clerk session (mounted after attachUser).
 * The desktop authenticates with the same MustaFlow account as the web app.
 * Desktop-specific long-lived tokens and the WebSocket relay are Phase 2C+.
 */

import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  oraxHostsTable,
  oraxPairingCodesTable,
  oraxPairedDevicesTable,
  oraxDesktopActionsTable,
  oraxThreadMessagesTable,
  oraxDesktopPendingApprovalsTable,
  oraxAuditLogTable,
  oraxUsageEventsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { classifyOraxCommand } from "../lib/orax-command-safety";
import { createChatCompletion } from "../lib/ai-providers";

const router = Router();

// ── Phase 2L: AI patch generation helpers ─────────────────────────────────────

/**
 * Compute a simple unified diff preview (pure TS — no shell, no exec).
 * Shows first 25 changed lines with 2 lines of context.
 */
function computeUnifiedDiffPreview(
  relPath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const MAX = 30;

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  out.push(`@@ -1,${Math.min(oldLines.length, MAX)} +1,${Math.min(newLines.length, MAX)} @@`);

  let i = 0;
  let j = 0;
  let emitted = 0;
  while ((i < oldLines.length || j < newLines.length) && emitted < MAX) {
    const ol = oldLines[i];
    const nl = newLines[j];
    if (i < oldLines.length && j < newLines.length && ol === nl) {
      out.push(` ${ol ?? ""}`);
      i++;
      j++;
    } else {
      if (i < oldLines.length) {
        out.push(`-${ol ?? ""}`);
        i++;
        emitted++;
      }
      if (j < newLines.length) {
        out.push(`+${nl ?? ""}`);
        j++;
        emitted++;
      }
    }
  }
  if (i < oldLines.length || j < newLines.length) {
    out.push("... (truncated)");
  }
  return out.join("\n");
}

/**
 * Call AI to generate real proposed file changes from file content + user message.
 * Returns null on parse failure so caller can fall back to skeleton draft.
 */
async function generateAiPatches(
  userMessage: string,
  filePreviews: Array<{ relativePath: string; contentPreview: string; originalHash: string }>,
): Promise<Array<{ relativePath: string; newContent: string; reason: string }> | null> {
  if (!userMessage.trim() || filePreviews.length === 0) return null;

  const fileContext = filePreviews
    .map((f) => `=== ${f.relativePath} ===\n${f.contentPreview}`)
    .join("\n\n");

  try {
    const response = await createChatCompletion({
      model: "gpt-4.1-mini",
      provider: "openai",
      messages: [
        {
          role: "system",
          content: [
            "You are a precise code editor assistant.",
            "Given a user request and file contents, return ONLY a JSON array of proposed file changes.",
            'Each element must be: { "relativePath": string, "newContent": string, "reason": string }',
            "Include the COMPLETE new file content, not a diff.",
            "Only include files that need changes.",
            "relativePath must exactly match one of the provided file paths.",
            "Respond with valid JSON only — no prose, no markdown code fences.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Request: ${userMessage.slice(0, 2000)}\n\nFiles:\n${fileContext.slice(0, 40_000)}`,
        },
      ],
    });

    const raw = (response.choices[0]?.message?.content ?? "").trim();
    // Strip optional ```json ... ``` fences
    const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }

    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.changes)
        ? ((parsed as Record<string, unknown>).changes as unknown[])
        : null!;

    if (!Array.isArray(arr)) return null;

    const valid = arr.filter(
      (item): item is { relativePath: string; newContent: string; reason: string } =>
        typeof (item as Record<string, unknown>)?.relativePath === "string" &&
        typeof (item as Record<string, unknown>)?.newContent === "string" &&
        typeof (item as Record<string, unknown>)?.reason === "string",
    );

    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

// ── Validation schemas ─────────────────────────────────────────────────────────

const registerHostSchema = z.object({
  deviceName: z.string().trim().min(1).max(120),
  platform: z.enum(["windows", "mac", "linux"]).default("windows"),
  osVersion: z.string().max(120).optional(),
  appVersion: z.string().max(40).default("0.0.0"),
  installId: z.string().uuid(),
  publicKey: z.string().max(2000).default(""),
  capabilities: z
    .object({
      shell: z.boolean().default(false),
      filesystem: z.boolean().default(false),
      git: z.boolean().default(false),
      github: z.boolean().default(false),
      browser: z.boolean().default(false),
      screenshot: z.boolean().default(false),
      computer_use: z.boolean().default(false),
    })
    .passthrough()
    .default({}),
  metadata: z.record(z.unknown()).default({}),
});

const patchHostSchema = z.object({
  deviceName: z.string().trim().min(1).max(120).optional(),
  permissionMode: z
    .enum(["read_only", "ask_everything", "ask_risky", "trusted_project", "full_access", "custom"])
    .optional(),
  capabilities: z.record(z.boolean()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createPairingCodeSchema = z.object({
  hostId: z.string().min(1).max(80),
});

const redeemPairingCodeSchema = z.object({
  code: z.string().min(1).max(20),
  mobileDeviceId: z.string().min(1).max(120),
  displayName: z.string().max(80).optional(),
  platform: z.enum(["ios", "android"]).optional(),
});

const heartbeatSchema = z.object({
  hostId: z.string().min(1).max(80),
  appVersion: z.string().max(40).optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function generatePairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function toHostSummary(host: typeof oraxHostsTable.$inferSelect) {
  return {
    id: host.id,
    deviceName: host.deviceName,
    platform: host.platform,
    osVersion: host.osVersion,
    appVersion: host.appVersion,
    status: host.status,
    capabilities: host.capabilities,
    permissionMode: host.permissionMode,
    lastSeenAt: host.lastSeenAt,
    pairedAt: host.pairedAt,
    revokedAt: host.revokedAt,
    metadata: host.metadata,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
}

async function loadOwnedHost(userId: string, hostId: string) {
  const [host] = await db
    .select()
    .from(oraxHostsTable)
    .where(and(eq(oraxHostsTable.id, hostId), eq(oraxHostsTable.userId, userId)))
    .limit(1);
  return host ?? null;
}

// ── Host registration ──────────────────────────────────────────────────────────

/**
 * POST /orax/hosts/register
 *
 * Called by Orax Desktop on first launch (after sign-in) and on reconnect.
 * If installId already exists for this user, updates the registration instead
 * of creating a duplicate. Returns the host row.
 */
router.post("/orax/hosts/register", async (req, res) => {
  const userId = req.userId!;
  const parsed = registerHostSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid host registration data" });
    return;
  }

  const d = parsed.data;

  try {
    // Check if this installId already has a row for this user.
    const [existing] = await db
      .select()
      .from(oraxHostsTable)
      .where(
        and(eq(oraxHostsTable.userId, userId), eq(oraxHostsTable.installId, d.installId)),
      )
      .limit(1);

    if (existing) {
      if (existing.revokedAt) {
        res.status(403).json({ error: "This host has been revoked. Re-register to continue." });
        return;
      }
      const [updated] = await db
        .update(oraxHostsTable)
        .set({
          deviceName: d.deviceName,
          platform: d.platform,
          osVersion: d.osVersion ?? existing.osVersion,
          appVersion: d.appVersion,
          publicKey: d.publicKey || existing.publicKey,
          status: "online",
          lastSeenAt: new Date(),
          capabilities: d.capabilities,
          metadata: d.metadata,
          updatedAt: new Date(),
        })
        .where(eq(oraxHostsTable.id, existing.id))
        .returning();
      logger.info({ component: "orax-desktop", hostId: updated.id }, "Orax host re-registered");
      res.json({ host: toHostSummary(updated), action: "updated" });
      return;
    }

    const [host] = await db
      .insert(oraxHostsTable)
      .values({
        userId,
        deviceName: d.deviceName,
        platform: d.platform,
        osVersion: d.osVersion,
        appVersion: d.appVersion,
        installId: d.installId,
        publicKey: d.publicKey,
        status: "online",
        lastSeenAt: new Date(),
        capabilities: d.capabilities,
        metadata: d.metadata,
      })
      .returning();

    logger.info({ component: "orax-desktop", hostId: host.id }, "New Orax host registered");
    res.status(201).json({ host: toHostSummary(host), action: "created" });
  } catch (err) {
    logger.error({ component: "orax-desktop", err }, "Failed to register Orax host");
    res.status(500).json({ error: "Failed to register host" });
  }
});

// ── Host list ──────────────────────────────────────────────────────────────────

/**
 * GET /orax/hosts
 *
 * Returns all non-revoked hosts registered under the user's account.
 * Used by web/mobile to show the host picker.
 */
router.get("/orax/hosts", async (req, res) => {
  const userId = req.userId!;
  try {
    const hosts = await db
      .select()
      .from(oraxHostsTable)
      .where(
        and(eq(oraxHostsTable.userId, userId), isNull(oraxHostsTable.revokedAt)),
      )
      .orderBy(desc(oraxHostsTable.lastSeenAt));
    res.json({ hosts: hosts.map(toHostSummary) });
  } catch (err) {
    logger.error({ component: "orax-desktop", err }, "Failed to list Orax hosts");
    res.status(500).json({ error: "Failed to load hosts" });
  }
});

// ── Host get ───────────────────────────────────────────────────────────────────

/**
 * GET /orax/hosts/:hostId
 */
router.get("/orax/hosts/:hostId", async (req, res) => {
  const userId = req.userId!;
  const hostId = req.params.hostId;
  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    res.json({ host: toHostSummary(host) });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to get Orax host");
    res.status(500).json({ error: "Failed to load host" });
  }
});

// ── Host patch ─────────────────────────────────────────────────────────────────

/**
 * PATCH /orax/hosts/:hostId
 *
 * Allows renaming the device and updating permissionMode or capabilities.
 */
router.patch("/orax/hosts/:hostId", async (req, res) => {
  const userId = req.userId!;
  const hostId = req.params.hostId;

  const parsed = patchHostSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update data" });
    return;
  }

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(403).json({ error: "Cannot update a revoked host" });
      return;
    }

    const patch: {
      deviceName?: string;
      permissionMode?: string;
      capabilities?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (parsed.data.deviceName !== undefined) patch.deviceName = parsed.data.deviceName;
    if (parsed.data.permissionMode !== undefined) patch.permissionMode = parsed.data.permissionMode;
    if (parsed.data.capabilities !== undefined) patch.capabilities = parsed.data.capabilities;
    if (parsed.data.metadata !== undefined) patch.metadata = parsed.data.metadata;

    const [updated] = await db
      .update(oraxHostsTable)
      .set(patch)
      .where(eq(oraxHostsTable.id, hostId))
      .returning();

    res.json({ host: toHostSummary(updated) });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to patch Orax host");
    res.status(500).json({ error: "Failed to update host" });
  }
});

// ── Host revoke ────────────────────────────────────────────────────────────────

/**
 * DELETE /orax/hosts/:hostId
 *
 * Marks the host as revoked. The relay will close the connection on next
 * heartbeat check. Existing pairing codes are invalidated.
 */
router.delete("/orax/hosts/:hostId", async (req, res) => {
  const userId = req.userId!;
  const hostId = req.params.hostId;
  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(409).json({ error: "Host is already revoked" });
      return;
    }

    const now = new Date();
    await db
      .update(oraxHostsTable)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(oraxHostsTable.id, hostId));

    logger.info({ component: "orax-desktop", hostId }, "Orax host revoked");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to revoke Orax host");
    res.status(500).json({ error: "Failed to revoke host" });
  }
});

// ── Pairing codes ──────────────────────────────────────────────────────────────

/**
 * POST /orax/pairing-codes
 *
 * Creates a new short-lived pairing code for the given host.
 * Invalidates any previous unredeemed codes for the same host.
 * Expires in 10 minutes.
 */
router.post("/orax/pairing-codes", async (req, res) => {
  const userId = req.userId!;
  const parsed = createPairingCodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid pairing code request" });
    return;
  }

  const { hostId } = parsed.data;

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(403).json({ error: "Cannot create pairing code for a revoked host" });
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    // Invalidate previous unredeemed codes for this host by marking them redeemed
    // (simpler than deleting; keeps audit trail intact).
    await db
      .update(oraxPairingCodesTable)
      .set({ redeemedAt: now, redeemedBy: "__invalidated__" })
      .where(
        and(
          eq(oraxPairingCodesTable.hostId, hostId),
          isNull(oraxPairingCodesTable.redeemedAt),
          gt(oraxPairingCodesTable.expiresAt, now),
        ),
      );

    const code = generatePairingCode();
    const qrPayload = JSON.stringify({
      code,
      userId,
      hostId,
      endpoint: "/api/orax/pairing-codes/redeem",
      expiresAt: expiresAt.toISOString(),
    });

    const [pairingCode] = await db
      .insert(oraxPairingCodesTable)
      .values({ hostId, userId, code, qrPayload, expiresAt })
      .returning();

    res.status(201).json({
      code: pairingCode.code,
      qrPayload: pairingCode.qrPayload,
      expiresAt: pairingCode.expiresAt,
    });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to create pairing code");
    res.status(500).json({ error: "Failed to create pairing code" });
  }
});

/**
 * POST /orax/pairing-codes/redeem
 *
 * Redeems a pairing code from a mobile or web client.
 * Security: code must not be expired, not already redeemed, and must belong
 * to the same userId as the signed-in session.
 */
router.post("/orax/pairing-codes/redeem", async (req, res) => {
  const userId = req.userId!;
  const parsed = redeemPairingCodeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid redeem request" });
    return;
  }

  const { code, mobileDeviceId, displayName, platform } = parsed.data;
  const now = new Date();

  try {
    const [pairingCode] = await db
      .select()
      .from(oraxPairingCodesTable)
      .where(eq(oraxPairingCodesTable.code, code.toUpperCase().trim()))
      .limit(1);

    if (!pairingCode) {
      res.status(404).json({ error: "Pairing code not found" });
      return;
    }
    if (pairingCode.userId !== userId) {
      res.status(403).json({ error: "This pairing code belongs to a different account" });
      return;
    }
    if (pairingCode.redeemedAt) {
      res.status(410).json({ error: "Pairing code has already been used" });
      return;
    }
    if (pairingCode.expiresAt < now) {
      res.status(410).json({ error: "Pairing code has expired" });
      return;
    }

    const host = await loadOwnedHost(userId, pairingCode.hostId);
    if (!host || host.revokedAt) {
      res.status(404).json({ error: "Host not found or revoked" });
      return;
    }

    await db
      .update(oraxPairingCodesTable)
      .set({ redeemedAt: now, redeemedBy: mobileDeviceId })
      .where(eq(oraxPairingCodesTable.id, pairingCode.id));

    await db
      .insert(oraxPairedDevicesTable)
      .values({
        hostId: pairingCode.hostId,
        userId,
        mobileDeviceId,
        displayName: displayName ?? null,
        platform: platform ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [oraxPairedDevicesTable.hostId, oraxPairedDevicesTable.mobileDeviceId],
        set: { lastSeenAt: now, revokedAt: null },
      });

    logger.info(
      { component: "orax-desktop", hostId: pairingCode.hostId, mobileDeviceId },
      "Orax Desktop paired with mobile device",
    );

    res.json({
      hostId: host.id,
      deviceName: host.deviceName,
      platform: host.platform,
      status: host.status,
    });
  } catch (err) {
    logger.error({ component: "orax-desktop", err }, "Failed to redeem pairing code");
    res.status(500).json({ error: "Failed to redeem pairing code" });
  }
});

/**
 * DELETE /orax/pairing-codes/:code
 *
 * Explicitly invalidates a pairing code before it expires.
 * The code must belong to a host owned by the user.
 */
router.delete("/orax/pairing-codes/:code", async (req, res) => {
  const userId = req.userId!;
  const code = req.params.code.toUpperCase().trim();
  const now = new Date();

  try {
    const [pairingCode] = await db
      .select()
      .from(oraxPairingCodesTable)
      .where(eq(oraxPairingCodesTable.code, code))
      .limit(1);

    if (!pairingCode || pairingCode.userId !== userId) {
      res.status(404).json({ error: "Pairing code not found" });
      return;
    }

    await db
      .update(oraxPairingCodesTable)
      .set({ redeemedAt: now, redeemedBy: "__cancelled__" })
      .where(eq(oraxPairingCodesTable.id, pairingCode.id));

    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "orax-desktop", err }, "Failed to cancel pairing code");
    res.status(500).json({ error: "Failed to cancel pairing code" });
  }
});

// ── Relay heartbeat ────────────────────────────────────────────────────────────

/**
 * POST /orax/relay/heartbeat
 *
 * REST heartbeat endpoint for Phase 2B. Called by Orax Desktop every 30s.
 * Updates last_seen_at and ensures status is 'online'.
 * Phase 2C+ will replace this with the persistent WebSocket relay; this
 * REST fallback remains available for environments that block WebSockets.
 */
router.post("/orax/relay/heartbeat", async (req, res) => {
  const userId = req.userId!;
  const parsed = heartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid heartbeat payload" });
    return;
  }

  const { hostId, appVersion } = parsed.data;

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(403).json({ error: "Host has been revoked" });
      return;
    }

    const now = new Date();
    const patch: Partial<typeof oraxHostsTable.$inferInsert> = {
      status: "online",
      lastSeenAt: now,
      updatedAt: now,
    };
    if (appVersion) patch.appVersion = appVersion;

    await db.update(oraxHostsTable).set(patch).where(eq(oraxHostsTable.id, hostId));

    res.json({ ok: true, serverTime: now.toISOString() });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Orax heartbeat failed");
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

// ── Phase 2E: action schemas ───────────────────────────────────────────────────

const createActionSchema = z.object({
  type: z.enum(["ping_desktop", "get_desktop_status", "list_local_projects"]),
  threadId: z.string().min(1).max(80).optional(),
  payload: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const postActionEventSchema = z.object({
  type: z.enum(["acknowledged", "running", "progress", "completed", "failed"]),
  payload: z.record(z.unknown()).default({}),
});

// ── Action creation (web/mobile → backend) ─────────────────────────────────────

/**
 * POST /orax/hosts/:hostId/actions
 *
 * Web/mobile dispatches a safe Phase 2E action to a desktop host.
 * Supported types: ping_desktop, get_desktop_status, list_local_projects.
 * The desktop picks it up on the next poll of /orax/relay/pending-actions.
 */
router.post("/orax/hosts/:hostId/actions", async (req, res) => {
  const userId = req.userId!;
  const hostId = req.params.hostId;

  const parsed = createActionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid action payload", details: parsed.error.issues });
    return;
  }

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(403).json({ error: "Host has been revoked" });
      return;
    }

    const { type, threadId, payload, idempotencyKey } = parsed.data;
    const iKey = idempotencyKey ?? `${userId}:${hostId}:${type}:${randomUUID()}`;

    const [action] = await db
      .insert(oraxDesktopActionsTable)
      .values({
        userId,
        hostId,
        threadId: threadId ?? null,
        type,
        status: "queued",
        payload,
        idempotencyKey: iKey,
      })
      .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
      .returning();

    if (!action) {
      const [existing] = await db
        .select()
        .from(oraxDesktopActionsTable)
        .where(eq(oraxDesktopActionsTable.idempotencyKey, iKey))
        .limit(1);
      res.json({ action: existing });
      return;
    }

    logger.info({ component: "orax-desktop", hostId, actionId: action.id, type }, "Action queued");
    res.status(201).json({ action });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to create action");
    res.status(500).json({ error: "Failed to create action" });
  }
});

// ── Action list (web/mobile reads results) ─────────────────────────────────────

/**
 * GET /orax/hosts/:hostId/actions
 *
 * Lists recent actions for a host. Web/mobile polls this to read results.
 */
router.get("/orax/hosts/:hostId/actions", async (req, res) => {
  const userId = req.userId!;
  const hostId = req.params.hostId;

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }

    const actions = await db
      .select()
      .from(oraxDesktopActionsTable)
      .where(
        and(
          eq(oraxDesktopActionsTable.userId, userId),
          eq(oraxDesktopActionsTable.hostId, hostId),
        ),
      )
      .orderBy(desc(oraxDesktopActionsTable.createdAt))
      .limit(50);

    res.json({ actions });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to list actions");
    res.status(500).json({ error: "Failed to list actions" });
  }
});

// ── Relay: desktop polls for pending actions ────────────────────────────────────

/**
 * GET /orax/relay/pending-actions
 *
 * Called by Orax Desktop every ~5 s to check for queued actions.
 * Returns all queued actions for the given hostId and marks them as "sent".
 * The desktop authenticates with the same Bearer token it uses for heartbeats.
 */
router.get("/orax/relay/pending-actions", async (req, res) => {
  const userId = req.userId!;
  const hostId = typeof req.query.hostId === "string" ? req.query.hostId : null;

  if (!hostId) {
    res.status(400).json({ error: "hostId query param required" });
    return;
  }

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(403).json({ error: "Host has been revoked" });
      return;
    }

    const queued = await db
      .select()
      .from(oraxDesktopActionsTable)
      .where(
        and(
          eq(oraxDesktopActionsTable.userId, userId),
          eq(oraxDesktopActionsTable.hostId, hostId),
          eq(oraxDesktopActionsTable.status, "queued"),
        ),
      )
      .orderBy(oraxDesktopActionsTable.createdAt)
      .limit(20);

    if (queued.length > 0) {
      await db
        .update(oraxDesktopActionsTable)
        .set({ status: "sent", updatedAt: new Date() })
        .where(
          inArray(
            oraxDesktopActionsTable.id,
            queued.map((a) => a.id),
          ),
        );
    }

    res.json({ actions: queued });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to fetch pending actions");
    res.status(500).json({ error: "Failed to fetch pending actions" });
  }
});

// ── Relay: desktop reports action event ────────────────────────────────────────

/**
 * POST /orax/relay/actions/:actionId/events
 *
 * Called by Orax Desktop to acknowledge, report progress, or complete/fail
 * an action. Updates the action row and, if a threadId is set, appends a
 * thread message for UI display.
 */
router.post("/orax/relay/actions/:actionId/events", async (req, res) => {
  const userId = req.userId!;
  const actionId = req.params.actionId;

  const parsed = postActionEventSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid event payload" });
    return;
  }

  try {
    const [action] = await db
      .select()
      .from(oraxDesktopActionsTable)
      .where(
        and(
          eq(oraxDesktopActionsTable.id, actionId),
          eq(oraxDesktopActionsTable.userId, userId),
        ),
      )
      .limit(1);

    if (!action) {
      res.status(404).json({ error: "Action not found" });
      return;
    }

    const { type, payload } = parsed.data;
    const now = new Date();

    const statusMap: Record<string, string> = {
      acknowledged: "acknowledged",
      running: "running",
      progress: "running",
      completed: "completed",
      failed: "failed",
    };

    const newStatus = statusMap[type] ?? action.status;
    const patch: Record<string, unknown> = { status: newStatus, updatedAt: now };

    if (type === "acknowledged") patch.startedAt = now;
    if (type === "completed" || type === "failed") {
      patch.result = payload;
      patch.completedAt = now;
    }

    await db
      .update(oraxDesktopActionsTable)
      .set(patch as Partial<typeof oraxDesktopActionsTable.$inferInsert>)
      .where(eq(oraxDesktopActionsTable.id, actionId));

    if (action.threadId && (type === "completed" || type === "failed")) {
      const isProjectThread = action.type === "run_project_thread";
      const isDraftPatch = action.type === "draft_project_patch";
      const isApplyPatch = action.type === "apply_project_patch";
      const isVerifyPatch = action.type === "verify_project_patch";
      const isFixDraft = action.type === "draft_project_fix";
      const isPrepPr = action.type === "prepare_project_pr";

      let content: string;
      let eventType: string;
      let role: string;
      let skipSharedInsert = false;

      if (isProjectThread && type === "completed") {
        const p = (payload ?? {}) as {
          projectInspection?: { summaryText?: string; error?: string };
          fileReadSummary?: Array<{ relativePath: string; truncated: boolean; reason: string }>;
          suggestedPlan?: string;
          warnings?: string[];
          selectedFiles?: Array<{ relativePath: string; category: string; reason: string; score: number }>;
        };

        const hasFileReads = Array.isArray(p.fileReadSummary) && p.fileReadSummary.length > 0;

        if (hasFileReads) {
          const fileList = p.fileReadSummary!
            .map((f) => `- ${f.relativePath}${f.truncated ? " (truncated)" : ""}`)
            .join("\n");
          const planSection = p.suggestedPlan ? `\n\n${p.suggestedPlan}` : "";
          const warnSection =
            Array.isArray(p.warnings) && p.warnings.length > 0
              ? `\n\nNote: ${p.warnings.slice(0, 3).join("; ")}`
              : "";
          content = `I inspected the following files:\n\n${fileList}${planSection}${warnSection}`;
          eventType = "project_files_read";
          role = "assistant";
        } else {
          content =
            p.projectInspection?.summaryText ??
            "Orax connected to the desktop project and verified the local workspace.";
          eventType = "project_context_inspected";
          role = "assistant";
        }
      } else if (isProjectThread && type === "failed") {
        const errMsg = (payload as { error?: string }).error ?? "unknown error";
        const safeErr = errMsg.replace(/\/[^\s]*/g, "[path]");
        content = `I could not inspect the desktop project: ${safeErr}`;
        eventType = "project_run_failed";
        role = "assistant";
      } else if (isDraftPatch && type === "completed") {
        // Phase 2L: call AI to generate real patches, then write project_patch_drafted
        const dp = (payload ?? {}) as {
          draftPatch?: {
            summary: string;
            changedFiles: Array<{
              relativePath: string;
              operation: string;
              intentDescription: string;
              hunkPreview: string[];
              originalHash?: string;
              oldContentPreview?: string;
            }>;
            risks: string[];
            verificationPlan: string[];
            draftGeneratedAt: string;
          };
          filePreviews?: Array<{ relativePath: string; contentPreview: string; originalHash: string }>;
          userMessage?: string;
          warnings?: string[];
        };

        // Phase 2L: enrich with AI-generated real code changes
        let enrichedDraft = dp.draftPatch;
        if (
          enrichedDraft &&
          Array.isArray(dp.filePreviews) &&
          dp.filePreviews.length > 0 &&
          dp.userMessage
        ) {
          try {
            const aiPatches = await generateAiPatches(dp.userMessage, dp.filePreviews);
            if (aiPatches && aiPatches.length > 0) {
              const byPath = new Map(aiPatches.map((p) => [p.relativePath, p]));
              enrichedDraft = {
                ...enrichedDraft,
                changedFiles: enrichedDraft.changedFiles.map((cf) => {
                  const ai = byPath.get(cf.relativePath);
                  if (!ai) return cf;
                  const oldPreview =
                    dp.filePreviews!.find((fp) => fp.relativePath === cf.relativePath)
                      ?.contentPreview ?? null;
                  const unifiedDiffPreview =
                    oldPreview && ai.newContent
                      ? computeUnifiedDiffPreview(cf.relativePath, oldPreview, ai.newContent)
                      : undefined;
                  return {
                    ...cf,
                    newContent: ai.newContent,
                    unifiedDiffPreview,
                    reason: ai.reason,
                  };
                }),
              };
            }
          } catch (aiErr) {
            logger.warn(
              { component: "orax-desktop", err: aiErr, actionId },
              "AI patch generation failed — using skeleton draft",
            );
          }
        }

        // Preserve sourceLocalPath from action.payload for the apply step
        const actionOrigPl = (action.payload ?? {}) as { sourceLocalPath?: string };
        const sourceLocalPathForApply = actionOrigPl.sourceLocalPath ?? null;

        const draft = enrichedDraft;
        if (draft?.summary) {
          const fileNames = (draft.changedFiles ?? []).map((f) => f.relativePath).join(", ");
          const aiEnriched = (draft.changedFiles ?? []).some(
            (f) => (f as { newContent?: string }).newContent,
          );
          const risksSection =
            (draft.risks ?? []).length > 0
              ? `\n\nRisks:\n${draft.risks.map((r) => `- ${r}`).join("\n")}`
              : "";
          const verifySection =
            (draft.verificationPlan ?? []).length > 0
              ? `\n\nVerification:\n${draft.verificationPlan.map((v) => `- ${v}`).join("\n")}`
              : "";
          const aiNote = aiEnriched ? " Real code changes are ready to apply." : "";
          content = `${draft.summary}${aiNote}${fileNames ? `\n\nFiles: ${fileNames}` : ""}${risksSection}${verifySection}`;
        } else {
          content = "Patch draft is ready. Review the proposed changes before approving.";
        }
        eventType = "project_patch_drafted";
        role = "assistant";

        // For isDraftPatch we build a richer message payload — handled below via extraPayload
        const extraPayload = {
          actionId,
          actionType: action.type,
          draftPatch: enrichedDraft, // enriched version with newContent/unifiedDiffPreview
          sourceLocalPath: sourceLocalPathForApply,
          ...(dp.userMessage ? { userMessage: dp.userMessage } : {}),
        };

        await db.insert(oraxThreadMessagesTable).values({
          threadId: action.threadId,
          role,
          content,
          eventType,
          payload: extraPayload,
        });

        // isDraftPatch custom insert done above — skip the shared insert
        skipSharedInsert = true;
      } else if (isDraftPatch && type === "failed") {
        const errMsg = (payload as { error?: string }).error ?? "unknown error";
        content = `Could not draft a patch: ${errMsg.replace(/\/[^\s]*/g, "[path]")}`;
        eventType = "project_patch_draft_failed";
        role = "assistant";
      } else if (isApplyPatch && type === "completed") {
        // Phase 2L: patch apply completed — write project_patch_applied message
        const ap = (payload ?? {}) as {
          changedFiles?: Array<{
            relativePath: string;
            operation: string;
            checkpointBackupPath: string | null;
          }>;
          checkpointPath?: string;
          warnings?: string[];
          durationMs?: number;
        };
        const changed = ap.changedFiles ?? [];
        const fileList = changed.map((f) => `- ${f.relativePath} (${f.operation})`).join("\n");
        const warnNote =
          (ap.warnings ?? []).length > 0
            ? `\n\nWarnings:\n${ap.warnings!.slice(0, 3).map((w) => `- ${w}`).join("\n")}`
            : "";
        const checkpointNote = ap.checkpointPath
          ? `\n\nOriginals backed up in .orax/checkpoints.`
          : "";
        content =
          changed.length > 0
            ? `Patch applied successfully — ${changed.length} file${changed.length === 1 ? "" : "s"} written:\n\n${fileList}${checkpointNote}${warnNote}`
            : "Patch applied — no files were changed.";
        eventType = "project_patch_applied";
        role = "assistant";
      } else if (isApplyPatch && type === "failed") {
        const errMsg = (payload as { error?: string }).error ?? "unknown error";
        content = `Could not apply the patch: ${errMsg.replace(/\/[^\s]*/g, "[path]")}`;
        eventType = "project_patch_failed";
        role = "assistant";
      } else if (isVerifyPatch && type === "completed") {
        // Phase 2M: verification results — write verified or verification_failed message
        const vp = (payload ?? {}) as {
          checks?: Array<{
            name: string;
            command: string;
            status: "passed" | "failed" | "skipped";
            stdout: string;
            stderr: string;
            exitCode: number | null;
            durationMs: number;
          }>;
          allPassed?: boolean;
          totalDurationMs?: number;
        };
        const checks = vp.checks ?? [];
        const allPassed =
          typeof vp.allPassed === "boolean"
            ? vp.allPassed
            : checks.every((c) => c.status !== "failed");

        if (checks.length === 0) {
          content = "Verification complete — no check scripts found in this project.";
          eventType = "project_patch_verified";
          role = "assistant";
        } else if (allPassed) {
          const summary = checks
            .map((c) => `- ${c.name}: ${c.status} (${c.durationMs}ms)`)
            .join("\n");
          content = `Verification passed — all checks succeeded.\n\n${summary}`;
          eventType = "project_patch_verified";
          role = "assistant";
        } else {
          const failed = checks.filter((c) => c.status === "failed");
          const summary = checks
            .map((c) => `- ${c.name}: ${c.status} (${c.durationMs}ms)`)
            .join("\n");
          const errDetail = failed
            .slice(0, 2)
            .map((c) => `${c.name}:\n${(c.stderr || c.stdout).slice(0, 500)}`)
            .join("\n\n");
          content =
            `Verification failed — ${failed.length} check${failed.length === 1 ? "" : "s"} did not pass.\n\n` +
            summary +
            (errDetail ? `\n\nDetails:\n${errDetail}` : "");
          eventType = "project_patch_verification_failed";
          role = "assistant";
        }
      } else if (isVerifyPatch && type === "failed") {
        const errMsg = (payload as { error?: string }).error ?? "unknown error";
        content = `Could not run verification checks: ${errMsg.replace(/\/[^\s]*/g, "[path]")}`;
        eventType = "project_patch_verification_failed";
        role = "assistant";
      } else if (isFixDraft && type === "completed") {
        // Phase 2N: fix patch draft completed — write project_fix_drafted message
        const fp = (payload ?? {}) as {
          draftPatch?: {
            summary: string;
            changedFiles: Array<{
              relativePath: string;
              operation: string;
              intentDescription: string;
              hunkPreview: string[];
              originalHash?: string;
              oldContentPreview?: string;
            }>;
            risks: string[];
            verificationPlan: string[];
            draftGeneratedAt: string;
          };
          filePreviews?: Array<{
            relativePath: string;
            contentPreview: string;
            originalHash: string;
          }>;
          originalUserMessage?: string;
          failedChecks?: Array<{
            name: string;
            stdout: string;
            stderr: string;
            exitCode: number | null;
            status: string;
          }>;
          warnings?: string[];
        };

        let fixEnrichedDraft = fp.draftPatch;

        if (fixEnrichedDraft && Array.isArray(fp.filePreviews) && fp.filePreviews.length > 0) {
          const failedOutput = (fp.failedChecks ?? [])
            .filter((c) => c.status === "failed")
            .slice(0, 2)
            .map((c) => `${c.name}:\n${(c.stderr || c.stdout).slice(0, 400)}`)
            .join("\n\n");
          const augmentedMsg =
            (fp.originalUserMessage ?? "Fix verification failure") +
            (failedOutput ? `\n\nVerification failed with:\n${failedOutput}` : "");

          try {
            const aiFixPatches = await generateAiPatches(augmentedMsg, fp.filePreviews);
            if (aiFixPatches && aiFixPatches.length > 0) {
              const byPath = new Map(aiFixPatches.map((p) => [p.relativePath, p]));
              fixEnrichedDraft = {
                ...fixEnrichedDraft,
                changedFiles: fixEnrichedDraft.changedFiles.map((cf) => {
                  const ai = byPath.get(cf.relativePath);
                  if (!ai) return cf;
                  const prevPreview =
                    fp.filePreviews!.find((fp2) => fp2.relativePath === cf.relativePath)
                      ?.contentPreview ?? null;
                  const unifiedDiffPreview =
                    prevPreview && ai.newContent
                      ? computeUnifiedDiffPreview(cf.relativePath, prevPreview, ai.newContent)
                      : undefined;
                  return {
                    ...cf,
                    newContent: ai.newContent,
                    unifiedDiffPreview,
                    reason: ai.reason,
                  };
                }),
              };
            }
          } catch (aiFixErr) {
            logger.warn(
              { component: "orax-desktop", err: aiFixErr, actionId },
              "AI fix patch generation failed — using skeleton draft",
            );
          }
        }

        const fixActionOrigPl = (action.payload ?? {}) as { sourceLocalPath?: string };
        const fixSourceLocalPath = fixActionOrigPl.sourceLocalPath ?? null;

        const fixDraft = fixEnrichedDraft;
        if (fixDraft?.summary) {
          const fileNames = (fixDraft.changedFiles ?? []).map((f) => f.relativePath).join(", ");
          const aiEnriched = (fixDraft.changedFiles ?? []).some(
            (f) => (f as { newContent?: string }).newContent,
          );
          const risksSection =
            (fixDraft.risks ?? []).length > 0
              ? `\n\nRisks:\n${fixDraft.risks.map((r) => `- ${r}`).join("\n")}`
              : "";
          const verifySection =
            (fixDraft.verificationPlan ?? []).length > 0
              ? `\n\nVerification:\n${fixDraft.verificationPlan.map((v) => `- ${v}`).join("\n")}`
              : "";
          const aiNote = aiEnriched ? " Real code changes are ready to apply." : "";
          content = `${fixDraft.summary}${aiNote}${fileNames ? `\n\nFiles: ${fileNames}` : ""}${risksSection}${verifySection}`;
        } else {
          content = "Fix draft is ready. Review the proposed changes before applying.";
        }
        eventType = "project_fix_drafted";
        role = "assistant";

        const fixExtraPayload = {
          actionId,
          actionType: action.type,
          draftPatch: fixEnrichedDraft,
          sourceLocalPath: fixSourceLocalPath,
          ...(fp.originalUserMessage ? { userMessage: fp.originalUserMessage } : {}),
        };

        await db.insert(oraxThreadMessagesTable).values({
          threadId: action.threadId,
          role,
          content,
          eventType,
          payload: fixExtraPayload,
        });
        skipSharedInsert = true;
      } else if (isFixDraft && type === "failed") {
        const errMsg = (payload as { error?: string }).error ?? "unknown error";
        content = `Could not draft a fix: ${errMsg.replace(/\/[^\s]*/g, "[path]")}`;
        eventType = "project_fix_draft_failed";
        role = "assistant";
      } else if (isPrepPr && type === "completed") {
        // Phase 3B/3C: PR branch + commit completed — may be ready, blocked, or partial
        const pp = (payload ?? {}) as {
          branchName?: string;
          baseBranch?: string | null;
          commitSha?: string;
          changedFiles?: string[];
          repoOwner?: string | null;
          repoName?: string | null;
          prUrl?: string | null;
          prNumber?: number | null;
          blockerType?: string | null;
          blockerReason?: string | null;
          warnings?: string[];
          durationMs?: number;
        };

        const branchName = pp.branchName ?? "orax/patch";
        const commitSha = pp.commitSha ?? "";
        const prUrl = pp.prUrl ?? null;
        const prNumber = pp.prNumber ?? null;
        const blockerType = pp.blockerType ?? null;
        const blockerReason = pp.blockerReason ?? null;
        const shortSha = commitSha.slice(0, 8);

        // Hard blockers: no GitHub remote, no git repo, or push failed
        const isHardBlocked =
          blockerType === "no_github_remote" ||
          blockerType === "no_git_repo" ||
          blockerType === "push_failed";

        if (isHardBlocked) {
          content =
            blockerReason ??
            "GitHub connection required to create a pull request. Check device settings.";
          eventType = "project_pr_blocked";
          role = "assistant";
        } else {
          const prLabel =
            prNumber != null ? `, PR #${prNumber} created` : " pushed";
          content = prUrl
            ? `Branch \`${branchName}\`${prLabel}. ${blockerType === "api_create_failed" ? "PR creation failed — open manually." : "Pull request ready."}`
            : `Branch \`${branchName}\` committed (${shortSha}). No remote push — open a PR manually.`;
          eventType = "project_pr_ready";
          role = "assistant";
        }

        await db.insert(oraxThreadMessagesTable).values({
          threadId: action.threadId,
          role,
          content,
          eventType,
          payload: {
            actionId,
            actionType: action.type,
            branchName,
            baseBranch: pp.baseBranch ?? null,
            commitSha,
            changedFiles: pp.changedFiles ?? [],
            repoOwner: pp.repoOwner ?? null,
            repoName: pp.repoName ?? null,
            prUrl,
            prNumber,
            blockerType,
            blockerReason,
            warnings: pp.warnings ?? [],
            durationMs: pp.durationMs ?? 0,
          },
        });
        skipSharedInsert = true;
      } else if (isPrepPr && type === "failed") {
        const errMsg = (payload as { error?: string }).error ?? "unknown error";
        content = `Could not prepare the pull request: ${errMsg.replace(/\/[^\s]*/g, "[path]")}`;
        eventType = "project_pr_failed";
        role = "assistant";
      } else {
        content =
          type === "completed"
            ? JSON.stringify(payload, null, 2)
            : `Action failed: ${(payload as { error?: string }).error ?? "unknown error"}`;
        eventType = `action_${type}`;
        role = "system";
      }

      if (!skipSharedInsert) {
        await db.insert(oraxThreadMessagesTable).values({
          threadId: action.threadId,
          role,
          content,
          eventType,
          payload: { actionId, actionType: action.type, ...(payload as object) },
        });
      }

      // Phase 2M: after a successful patch apply, queue verify_project_patch
      if (isApplyPatch && type === "completed" && action.threadId) {
        const applyPl = (action.payload ?? {}) as {
          sourceLocalPath?: string;
          projectId?: string;
          executionSourceId?: string;
        };
        if (applyPl.sourceLocalPath && applyPl.projectId) {
          const verifyIKey = `verify-patch:${action.threadId}:${actionId}`;
          void db
            .insert(oraxDesktopActionsTable)
            .values({
              userId,
              hostId: action.hostId,
              threadId: action.threadId,
              type: "verify_project_patch",
              status: "queued",
              payload: {
                projectId: applyPl.projectId,
                threadId: action.threadId,
                executionSourceId: applyPl.executionSourceId ?? null,
                sourceLocalPath: applyPl.sourceLocalPath,
              },
              idempotencyKey: verifyIKey,
            })
            .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
            .catch((qErr: unknown) => {
              logger.warn(
                { component: "orax-desktop", err: qErr, actionId },
                "Failed to queue verify_project_patch",
              );
            });
        }
      }

      // Phase 2K: after a successful file-read, queue draft_project_patch
      if (isProjectThread && type === "completed") {
        const rfPayload = (payload ?? {}) as {
          fileReadSummary?: unknown[];
          projectId?: string;
          executionSourceId?: string;
          selectedFiles?: unknown[];
        };
        const srcPayload = (action.payload ?? {}) as {
          sourceLocalPath?: string;
          userMessage?: string;
        };
        if (
          Array.isArray(rfPayload.fileReadSummary) &&
          rfPayload.fileReadSummary.length > 0 &&
          rfPayload.projectId &&
          srcPayload.sourceLocalPath
        ) {
          const draftIKey = `draft-patch:${action.threadId}:${actionId}`;
          void db
            .insert(oraxDesktopActionsTable)
            .values({
              userId,
              hostId: action.hostId,
              threadId: action.threadId,
              type: "draft_project_patch",
              status: "queued",
              payload: {
                projectId: rfPayload.projectId,
                threadId: action.threadId,
                executionSourceId: rfPayload.executionSourceId,
                sourceLocalPath: srcPayload.sourceLocalPath,
                userMessage: srcPayload.userMessage ?? "",
                selectedFiles: rfPayload.selectedFiles ?? [],
              },
              idempotencyKey: draftIKey,
            })
            .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
            .catch((qErr: unknown) => {
              logger.warn(
                { component: "orax-desktop", err: qErr, actionId },
                "Failed to queue draft_project_patch",
              );
            });
        }
      }
    }

    // ── run_safe_command completion audit + usage logging ──────────────────
    if ((type === "completed" || type === "failed") && action.type === "run_safe_command") {
      const actionPayload = (action.payload ?? {}) as { command?: string; approvalId?: string };
      const eventPayload = (payload ?? {}) as {
        exitCode?: number | null;
        durationMs?: number;
        timedOut?: boolean;
      };

      void db
        .insert(oraxAuditLogTable)
        .values({
          userId,
          hostId: action.hostId,
          ...(action.threadId ? { threadId: action.threadId } : {}),
          action: type === "completed" ? "command_completed" : "command_failed",
          command: actionPayload.command ?? null,
          outcome: type === "completed" ? "success" : "failed",
          metadata: {
            exitCode: eventPayload.exitCode ?? null,
            durationMs: eventPayload.durationMs ?? null,
            timedOut: eventPayload.timedOut ?? false,
            actionId,
            approvalId: actionPayload.approvalId ?? null,
          },
        })
        .catch((err: unknown) => {
          logger.warn({ component: "orax-desktop", err, actionId }, "Failed to write command audit log");
        });

      void db
        .insert(oraxUsageEventsTable)
        .values({
          userId,
          hostId: action.hostId,
          ...(action.threadId ? { threadId: action.threadId } : {}),
          actionType: "command_execution",
          status: type === "completed" ? "success" : "failed",
          ...(typeof eventPayload.durationMs === "number"
            ? { computeMs: eventPayload.durationMs }
            : {}),
          metadata: {
            command: actionPayload.command ?? null,
            exitCode: eventPayload.exitCode ?? null,
            timedOut: eventPayload.timedOut ?? false,
          },
        })
        .catch((err: unknown) => {
          logger.warn({ component: "orax-desktop", err, actionId }, "Failed to write command usage event");
        });
    }

    logger.info(
      { component: "orax-desktop", actionId, type, newStatus },
      "Action event recorded",
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, actionId }, "Failed to post action event");
    res.status(500).json({ error: "Failed to post action event" });
  }
});

// ── Phase 2F: command approval schemas ────────────────────────────────────────

const commandApprovalSchema = z.object({
  threadId: z.string().min(1).max(80).optional(),
  command: z.string().trim().min(1).max(500),
  cwd: z.string().max(500).optional(),
  reason: z.string().trim().min(1).max(500),
});

const resolveApprovalSchema = z.object({
  decision: z.enum(["approved", "denied"]),
});

// ── Phase 2F: POST /orax/hosts/:hostId/command-approvals ──────────────────────

/**
 * POST /orax/hosts/:hostId/command-approvals
 *
 * User requests to run a safe command on a desktop host. The backend
 * classifies the command, creates a pending approval, and returns it so the
 * web/mobile UI can show an inline Approve/Deny card.
 */
router.post("/orax/hosts/:hostId/command-approvals", async (req, res) => {
  const userId = req.userId!;
  const hostId = req.params.hostId;

  const parsed = commandApprovalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const { threadId, command, cwd, reason } = parsed.data;

  try {
    const host = await loadOwnedHost(userId, hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    if (host.revokedAt) {
      res.status(403).json({ error: "Host has been revoked" });
      return;
    }

    const classification = classifyOraxCommand(command);
    if (!classification.allowed) {
      res.status(422).json({
        error: "Command not permitted",
        risk: classification.risk,
        reason: classification.reason,
      });
      return;
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const [approval] = await db
      .insert(oraxDesktopPendingApprovalsTable)
      .values({
        userId,
        hostId,
        ...(threadId ? { threadId } : {}),
        description: reason,
        command: classification.normalizedCommand,
        ...(cwd ? { cwd } : {}),
        reason,
        riskLevel: classification.risk,
        expiresAt,
        status: "pending",
      })
      .returning();

    await db.insert(oraxAuditLogTable).values({
      userId,
      hostId,
      ...(threadId ? { threadId } : {}),
      action: "command_approval_requested",
      command: classification.normalizedCommand,
      outcome: "pending",
      metadata: { riskLevel: classification.risk, reason },
    });

    if (threadId) {
      await db.insert(oraxThreadMessagesTable).values({
        threadId,
        role: "system",
        content: `Approval requested: ${classification.normalizedCommand}`,
        eventType: "command_approval_requested",
        payload: { approvalId: approval!.id, command: classification.normalizedCommand },
      });
    }

    logger.info(
      { component: "orax-desktop", userId, hostId, approvalId: approval!.id, command },
      "Command approval created",
    );
    res.status(201).json({ approval });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, hostId }, "Failed to create command approval");
    res.status(500).json({ error: "Failed to create command approval" });
  }
});

// ── Phase 2F: POST /orax/approvals/:approvalId/resolve ────────────────────────

/**
 * POST /orax/approvals/:approvalId/resolve
 *
 * Approves or denies a pending command approval. Approved: creates a
 * queued run_safe_command action for the desktop. Denied: marks it denied
 * and writes an audit record. No action is created when denied.
 */
router.post("/orax/approvals/:approvalId/resolve", async (req, res) => {
  const userId = req.userId!;
  const approvalId = req.params.approvalId;

  const parsed = resolveApprovalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const { decision } = parsed.data;

  try {
    const [approval] = await db
      .select()
      .from(oraxDesktopPendingApprovalsTable)
      .where(
        and(
          eq(oraxDesktopPendingApprovalsTable.id, approvalId),
          eq(oraxDesktopPendingApprovalsTable.userId, userId),
        ),
      )
      .limit(1);

    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (approval.status !== "pending") {
      res.status(409).json({ error: `Approval is already ${approval.status}` });
      return;
    }
    if (approval.expiresAt && approval.expiresAt < new Date()) {
      await db
        .update(oraxDesktopPendingApprovalsTable)
        .set({ status: "expired", resolvedAt: new Date() })
        .where(eq(oraxDesktopPendingApprovalsTable.id, approvalId));
      res.status(410).json({ error: "Approval has expired" });
      return;
    }

    const now = new Date();

    if (decision === "denied") {
      await db
        .update(oraxDesktopPendingApprovalsTable)
        .set({ status: "denied", resolvedAt: now, resolvedBy: userId })
        .where(eq(oraxDesktopPendingApprovalsTable.id, approvalId));

      await db.insert(oraxAuditLogTable).values({
        userId,
        hostId: approval.hostId,
        ...(approval.threadId ? { threadId: approval.threadId } : {}),
        action: "command_approval_denied",
        command: approval.command,
        outcome: "denied",
        metadata: {},
      });

      if (approval.threadId) {
        await db.insert(oraxThreadMessagesTable).values({
          threadId: approval.threadId,
          role: "system",
          content: `Command denied: ${approval.command ?? ""}`,
          eventType: "command_approval_denied",
          payload: { approvalId },
        });
      }

      logger.info({ component: "orax-desktop", userId, approvalId }, "Command approval denied");
      res.json({ approval: { ...approval, status: "denied", resolvedAt: now } });
      return;
    }

    // decision === "approved" — update approval and queue run_safe_command action
    await db
      .update(oraxDesktopPendingApprovalsTable)
      .set({ status: "approved", resolvedAt: now, resolvedBy: userId })
      .where(eq(oraxDesktopPendingApprovalsTable.id, approvalId));

    const idempotencyKey = `${userId}:${approval.hostId}:run_safe_command:${approvalId}`;
    const [action] = await db
      .insert(oraxDesktopActionsTable)
      .values({
        userId,
        hostId: approval.hostId,
        ...(approval.threadId ? { threadId: approval.threadId } : {}),
        type: "run_safe_command",
        status: "queued",
        payload: {
          command: approval.command,
          cwd: approval.cwd,
          approvalId,
        },
        idempotencyKey,
      })
      .onConflictDoNothing({ target: oraxDesktopActionsTable.idempotencyKey })
      .returning();

    await db.insert(oraxAuditLogTable).values({
      userId,
      hostId: approval.hostId,
      ...(approval.threadId ? { threadId: approval.threadId } : {}),
      action: "command_approval_approved",
      command: approval.command,
      outcome: "approved",
      metadata: { actionId: action?.id },
    });

    if (approval.threadId) {
      await db.insert(oraxThreadMessagesTable).values({
        threadId: approval.threadId,
        role: "system",
        content: `Command approved — queued for desktop: ${approval.command ?? ""}`,
        eventType: "command_approval_approved",
        payload: { approvalId, actionId: action?.id },
      });
    }

    logger.info(
      { component: "orax-desktop", userId, approvalId, actionId: action?.id },
      "Command approval approved — action queued",
    );
    res.json({ approval: { ...approval, status: "approved", resolvedAt: now }, action });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, approvalId }, "Failed to resolve approval");
    res.status(500).json({ error: "Failed to resolve approval" });
  }
});

// ── Phase 2F: GET /orax/approvals/:approvalId ─────────────────────────────────

/**
 * GET /orax/approvals/:approvalId
 *
 * Poll for approval status. Used by web/mobile to track an approval created
 * by POST /orax/hosts/:hostId/command-approvals.
 */
router.get("/orax/approvals/:approvalId", async (req, res) => {
  const userId = req.userId!;
  const approvalId = req.params.approvalId;

  try {
    const [approval] = await db
      .select()
      .from(oraxDesktopPendingApprovalsTable)
      .where(
        and(
          eq(oraxDesktopPendingApprovalsTable.id, approvalId),
          eq(oraxDesktopPendingApprovalsTable.userId, userId),
        ),
      )
      .limit(1);

    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }

    res.json({ approval });
  } catch (err) {
    logger.error({ component: "orax-desktop", err, approvalId }, "Failed to get approval");
    res.status(500).json({ error: "Failed to get approval" });
  }
});

// ── Phase 2F: audit log on run_safe_command completion ────────────────────────
// (handled inline in the existing action-event handler below via the
//  run_safe_command type check — no separate route needed)

export default router;
