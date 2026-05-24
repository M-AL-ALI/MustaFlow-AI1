/**
 * Sentry error tracking — server-side initialisation.
 *
 * Initialised once at process start (init() is idempotent).
 * SENTRY_DSN env var activates Sentry; when unset, all calls are no-ops so
 * the app runs normally without error tracking configured.
 *
 * Usage:
 *   import { captureError, withSentryContext } from "./sentry";
 *   captureError(err, { userId, projectId, taskId });
 */

import * as Sentry from "@sentry/node";
import { logger } from "./logger";

let _initialised = false;

export function initSentry(): void {
  if (_initialised) return;
  _initialised = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info("SENTRY_DSN not set — Sentry error tracking disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.APP_VERSION ?? "unknown",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
    integrations: [Sentry.extraErrorDataIntegration()],
  });

  logger.info("Sentry initialised");
}

export type SentryContext = {
  userId?: string | null;
  projectId?: number | null;
  taskId?: number | null;
  agentMode?: string | null;
  stack?: string | null;
  [key: string]: unknown;
};

/**
 * Capture an error with optional MustaFlow-specific context tags.
 * Safe to call even if Sentry is not configured — falls back to a structured
 * logger.error call so nothing is silently swallowed.
 */
export function captureError(err: unknown, ctx?: SentryContext): void {
  const extras = ctx ?? {};
  logger.error({ err, ...extras }, "Captured error");

  if (!process.env.SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    if (ctx?.userId) scope.setUser({ id: ctx.userId as string });
    if (ctx?.projectId != null) scope.setTag("project_id", String(ctx.projectId));
    if (ctx?.taskId != null) scope.setTag("task_id", String(ctx.taskId));
    if (ctx?.agentMode) scope.setTag("agent_mode", ctx.agentMode as string);
    if (ctx?.stack) scope.setTag("stack", ctx.stack as string);
    scope.setExtras(extras as Record<string, unknown>);
    Sentry.captureException(err);
  });
}

/**
 * Wraps the Express error handler to forward unhandled errors to Sentry.
 * Call this AFTER your app-level error handler in app.ts.
 */
export { Sentry };
