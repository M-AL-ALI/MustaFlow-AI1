/**
 * Project webhook CRUD routes.
 *
 *   GET    /api/projects/:id/webhooks              — list webhooks
 *   POST   /api/projects/:id/webhooks              — create webhook
 *   PATCH  /api/projects/:id/webhooks/:hookId      — update (url / events / active)
 *   DELETE /api/projects/:id/webhooks/:hookId      — delete
 *   GET    /api/projects/:id/webhooks/:hookId/deliveries — delivery history
 *   POST   /api/projects/:id/webhooks/:hookId/test — fire a test delivery
 */

import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { db, projectWebhooksTable, webhookDeliveriesTable } from "@workspace/db";
import { WEBHOOK_EVENTS } from "@workspace/db";
import type { WebhookEvent } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { dispatchWebhookEvent } from "../lib/webhook-dispatcher";

const router: IRouter = Router();

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function maskSecret(secret: string): string {
  return `••••••••${secret.slice(-4)}`;
}

function validateEvents(events: unknown): events is WebhookEvent[] {
  if (!Array.isArray(events)) return false;
  return events.every((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e as string));
}

// ── GET /api/projects/:id/webhooks ────────────────────────────────────────────
router.get("/projects/:id/webhooks", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const hooks = await db
    .select()
    .from(projectWebhooksTable)
    .where(eq(projectWebhooksTable.projectId, projectId))
    .orderBy(projectWebhooksTable.createdAt);

  res.json({
    webhooks: hooks.map((h) => ({ ...h, secret: maskSecret(h.secret) })),
    availableEvents: WEBHOOK_EVENTS,
  });
});

// ── POST /api/projects/:id/webhooks ───────────────────────────────────────────
router.post("/projects/:id/webhooks", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const { url, events, description } = req.body as {
    url?: string;
    events?: unknown;
    description?: string;
  };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: "url must be a valid URL" });
    return;
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    res.status(400).json({ error: "url must start with https:// or http://" });
    return;
  }

  const eventsArr = events ?? WEBHOOK_EVENTS;
  if (!validateEvents(eventsArr)) {
    res.status(400).json({
      error: `events must be an array of: ${WEBHOOK_EVENTS.join(", ")}`,
    });
    return;
  }

  const secret = generateSecret();

  const [hook] = await db
    .insert(projectWebhooksTable)
    .values({
      projectId,
      url,
      secret,
      events: eventsArr,
      description: description?.slice(0, 200),
      active: true,
    })
    .returning();

  res.status(201).json({
    webhook: { ...hook, secret },
    note: "Store the secret now — it will not be shown again in full.",
  });
});

// ── PATCH /api/projects/:id/webhooks/:hookId ──────────────────────────────────
router.patch(
  "/projects/:id/webhooks/:hookId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const hookId = Number(req.params.hookId);

    const [existing] = await db
      .select()
      .from(projectWebhooksTable)
      .where(
        and(eq(projectWebhooksTable.id, hookId), eq(projectWebhooksTable.projectId, projectId)),
      );

    if (!existing) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    const { url, events, active, description, rotateSecret } = req.body as {
      url?: string;
      events?: unknown;
      active?: boolean;
      description?: string;
      rotateSecret?: boolean;
    };

    if (url !== undefined) {
      try {
        new URL(url);
      } catch {
        res.status(400).json({ error: "url must be a valid URL" });
        return;
      }
    }

    if (events !== undefined && !validateEvents(events)) {
      res.status(400).json({
        error: `events must be an array of: ${WEBHOOK_EVENTS.join(", ")}`,
      });
      return;
    }

    const newSecret = rotateSecret ? generateSecret() : undefined;

    const [updated] = await db
      .update(projectWebhooksTable)
      .set({
        ...(url !== undefined ? { url } : {}),
        ...(events !== undefined ? { events } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(description !== undefined ? { description: description.slice(0, 200) } : {}),
        ...(newSecret ? { secret: newSecret } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projectWebhooksTable.id, hookId))
      .returning();

    res.json({
      webhook: { ...updated, secret: newSecret ?? maskSecret(existing.secret) },
      ...(newSecret ? { note: "New secret shown once — store it now." } : {}),
    });
  },
);

// ── DELETE /api/projects/:id/webhooks/:hookId ─────────────────────────────────
router.delete(
  "/projects/:id/webhooks/:hookId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const hookId = Number(req.params.hookId);

    const [existing] = await db
      .select({ id: projectWebhooksTable.id })
      .from(projectWebhooksTable)
      .where(
        and(eq(projectWebhooksTable.id, hookId), eq(projectWebhooksTable.projectId, projectId)),
      );

    if (!existing) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    await db.delete(projectWebhooksTable).where(eq(projectWebhooksTable.id, hookId));
    res.json({ deleted: true });
  },
);

// ── GET /api/projects/:id/webhooks/:hookId/deliveries ─────────────────────────
router.get(
  "/projects/:id/webhooks/:hookId/deliveries",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const hookId = Number(req.params.hookId);
    const limit = Math.min(Number(req.query["limit"] ?? 50), 200);

    const [existing] = await db
      .select({ id: projectWebhooksTable.id })
      .from(projectWebhooksTable)
      .where(
        and(eq(projectWebhooksTable.id, hookId), eq(projectWebhooksTable.projectId, projectId)),
      );

    if (!existing) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    const deliveries = await db
      .select()
      .from(webhookDeliveriesTable)
      .where(eq(webhookDeliveriesTable.webhookId, hookId))
      .orderBy(desc(webhookDeliveriesTable.createdAt))
      .limit(limit);

    res.json({ deliveries });
  },
);

// ── POST /api/projects/:id/webhooks/:hookId/test ──────────────────────────────
router.post(
  "/projects/:id/webhooks/:hookId/test",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const hookId = Number(req.params.hookId);

    const [hook] = await db
      .select()
      .from(projectWebhooksTable)
      .where(
        and(eq(projectWebhooksTable.id, hookId), eq(projectWebhooksTable.projectId, projectId)),
      );

    if (!hook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    dispatchWebhookEvent(projectId, "domain.attached", {
      test: true,
      hostname: "example.mustaflow.app",
      note: "This is a test delivery from MustaFlow.",
    });

    res.json({ queued: true, message: "Test delivery dispatched — check deliveries shortly." });
  },
);

export default router;
