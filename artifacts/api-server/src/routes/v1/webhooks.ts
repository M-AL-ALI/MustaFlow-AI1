/**
 * /api/v1/projects/:id/webhooks — webhook CRUD with scope enforcement.
 *
 * Routes:
 *   GET    /api/v1/projects/:id/webhooks              — list webhooks (webhooks:read)
 *   POST   /api/v1/projects/:id/webhooks              — create a webhook (webhooks:write)
 *   DELETE /api/v1/projects/:id/webhooks/:webhookId   — delete a webhook (webhooks:write)
 */

import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, projectWebhooksTable, WEBHOOK_EVENTS } from "@workspace/db";
import type { WebhookEvent } from "@workspace/db";
import type { PATRequest } from "../../lib/pat-auth";
import { checkV1ProjectAccess, isPatAuth } from "./access";

const router: IRouter = Router();

// ── GET /api/v1/projects/:id/webhooks ─────────────────────────────────────────
router.get("/projects/:id/webhooks", async (req, res): Promise<void> => {
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("webhooks:read")) {
    res.status(403).json({ error: "Token does not have webhooks:read scope." });
    return;
  }

  const projectId = Number(req.params.id);
  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const webhooks = await db
    .select({
      id: projectWebhooksTable.id,
      projectId: projectWebhooksTable.projectId,
      url: projectWebhooksTable.url,
      events: projectWebhooksTable.events,
      active: projectWebhooksTable.active,
      description: projectWebhooksTable.description,
      createdAt: projectWebhooksTable.createdAt,
      updatedAt: projectWebhooksTable.updatedAt,
    })
    .from(projectWebhooksTable)
    .where(eq(projectWebhooksTable.projectId, projectId))
    .orderBy(asc(projectWebhooksTable.createdAt));

  res.json({ webhooks });
});

// ── POST /api/v1/projects/:id/webhooks ────────────────────────────────────────
router.post("/projects/:id/webhooks", async (req, res): Promise<void> => {
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("webhooks:write")) {
    res.status(403).json({ error: "Token does not have webhooks:write scope." });
    return;
  }

  const projectId = Number(req.params.id);
  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const { url, events, description } = req.body as {
    url?: string;
    events?: string[];
    description?: string;
  };

  if (!url || typeof url !== "string" || !url.trim()) {
    res.status(400).json({ error: "url is required." });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    res.status(400).json({ error: "Invalid URL." });
    return;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    res.status(400).json({ error: "URL must use http or https." });
    return;
  }

  const resolvedEvents: WebhookEvent[] = Array.isArray(events)
    ? (events.filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e)) as WebhookEvent[])
    : [...WEBHOOK_EVENTS];

  const secret = randomBytes(32).toString("hex");

  const [webhook] = await db
    .insert(projectWebhooksTable)
    .values({
      projectId,
      url: parsedUrl.toString(),
      secret,
      events: resolvedEvents,
      active: true,
      description: description ? String(description).slice(0, 255) : null,
    })
    .returning();

  res.status(201).json({ webhook, secret });
});

// ── DELETE /api/v1/projects/:id/webhooks/:webhookId ───────────────────────────
router.delete("/projects/:id/webhooks/:webhookId", async (req, res): Promise<void> => {
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("webhooks:write")) {
    res.status(403).json({ error: "Token does not have webhooks:write scope." });
    return;
  }

  const projectId = Number(req.params.id);
  const webhookId = Number(req.params.webhookId);

  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const [webhook] = await db
    .select({ id: projectWebhooksTable.id })
    .from(projectWebhooksTable)
    .where(
      and(eq(projectWebhooksTable.id, webhookId), eq(projectWebhooksTable.projectId, projectId)),
    );

  if (!webhook) {
    res.status(404).json({ error: "Webhook not found." });
    return;
  }

  await db.delete(projectWebhooksTable).where(eq(projectWebhooksTable.id, webhookId));

  res.json({ deleted: true });
});

export default router;
