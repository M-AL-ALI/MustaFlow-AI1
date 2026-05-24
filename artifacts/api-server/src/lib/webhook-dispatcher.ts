/**
 * Webhook dispatcher — HMAC-signed delivery with retry/backoff.
 *
 * Fires domain lifecycle events to registered project_webhooks rows.
 * All deliveries are audited in webhook_deliveries.
 *
 * Design:
 * - Each delivery attempt is logged.
 * - On failure the dispatcher retries up to 3 times with exponential backoff
 *   (1s, 4s, 16s). All async / best-effort — never blocks the request path.
 * - HMAC-SHA256 signature sent as X-Mustaflow-Signature header (hex).
 */

import { createHmac } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db, projectWebhooksTable, webhookDeliveriesTable } from "@workspace/db";
import type { WebhookEvent } from "@workspace/db";
import { logger } from "./logger";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 1_000, 4_000, 16_000];

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function deliverOnce(
  webhookId: number,
  projectId: number,
  event: WebhookEvent,
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  attempt: number,
): Promise<void> {
  const body = JSON.stringify(payload);
  const sig = sign(secret, body);
  const start = Date.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  let status: "success" | "failed" = "success";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mustaflow-Event": event,
        "X-Mustaflow-Signature": `sha256=${sig}`,
        "X-Mustaflow-Delivery": `${webhookId}-${attempt}-${Date.now()}`,
        "User-Agent": "MustaflowWebhooks/1.0",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = resp.status;
    responseBody = (await resp.text()).slice(0, 512);
    if (!resp.ok) {
      status = "failed";
      error = `HTTP ${resp.status}`;
    }
  } catch (err) {
    status = "failed";
    error = String(err instanceof Error ? err.message : err).slice(0, 512);
  }

  const durationMs = Date.now() - start;

  try {
    await db.insert(webhookDeliveriesTable).values({
      webhookId,
      projectId,
      event,
      payload,
      status,
      statusCode,
      responseBody,
      attempt,
      durationMs,
      error,
    });
  } catch (logErr) {
    logger.warn({ logErr }, "Failed to log webhook delivery");
  }

  if (status === "failed") {
    throw new Error(error ?? "delivery failed");
  }
}

async function deliverWithRetry(
  webhookId: number,
  projectId: number,
  event: WebhookEvent,
  url: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const wait = BACKOFF_MS[attempt - 1] ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await deliverOnce(webhookId, projectId, event, url, secret, payload, attempt);
      return; // success
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        logger.warn({ webhookId, event, url }, "Webhook delivery exhausted retries");
      }
    }
  }
}

/**
 * Fire a webhook event for a project. Non-blocking — always returns immediately.
 * Looks up active webhooks subscribed to this event and dispatches in background.
 */
export function dispatchWebhookEvent(
  projectId: number,
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  setImmediate(() => {
    void (async () => {
      try {
        const hooks = await db
          .select()
          .from(projectWebhooksTable)
          .where(eq(projectWebhooksTable.projectId, projectId));

        const subscribed = hooks.filter(
          (h) => h.active && Array.isArray(h.events) && (h.events as string[]).includes(event),
        );

        if (subscribed.length === 0) return;

        const payload: Record<string, unknown> = {
          event,
          projectId,
          ts: new Date().toISOString(),
          data,
        };

        await Promise.allSettled(
          subscribed.map((h) => deliverWithRetry(h.id, projectId, event, h.url, h.secret, payload)),
        );
      } catch (err) {
        logger.warn({ err, projectId, event }, "dispatchWebhookEvent outer error");
      }
    })();
  });
}

/**
 * Fire a webhook for multiple projects at once (e.g. cert expiry sweep).
 */
export function dispatchWebhookEventMulti(
  projectIds: number[],
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  for (const projectId of projectIds) {
    dispatchWebhookEvent(projectId, event, data);
  }
}
