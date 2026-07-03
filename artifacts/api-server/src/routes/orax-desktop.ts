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
} from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

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
      const content =
        type === "completed"
          ? JSON.stringify(payload, null, 2)
          : `Action failed: ${(payload as { error?: string }).error ?? "unknown error"}`;
      await db.insert(oraxThreadMessagesTable).values({
        threadId: action.threadId,
        role: "system",
        content,
        eventType: `action_${type}`,
        payload: { actionId, actionType: action.type, ...(payload as object) },
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

export default router;
