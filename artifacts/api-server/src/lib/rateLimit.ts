// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting middleware — Phase 4 abuse protection.
//
// Uses a simple in-memory store (sufficient for single-process dev/prod on Replit).
// Each limiter stores per-IP counters with a TTL matching the window.
//
// JSON 429 responses are returned when limits are exceeded.
// ─────────────────────────────────────────────────────────────────────────────

import type { Request, Response, NextFunction } from "express";

interface Window {
  count: number;
  resetAt: number;
}

const store = new Map<string, Window>();

function cleanupExpired() {
  const now = Date.now();
  for (const [key, win] of store.entries()) {
    if (win.resetAt <= now) store.delete(key);
  }
}

// Runs cleanup every 60 s to avoid unbounded memory growth.
setInterval(cleanupExpired, 60_000).unref();

function createLimiter(opts: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();

    let win = store.get(key);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + opts.windowMs };
      store.set(key, win);
    }

    win.count += 1;

    res.setHeader("X-RateLimit-Limit", opts.max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, opts.max - win.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(win.resetAt / 1000));

    if (win.count > opts.max) {
      res.status(429).json({
        error: opts.message ?? "Too many requests. Please slow down and try again.",
        retryAfter: Math.ceil((win.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

// AI builder requests — 20 per minute per IP
export const aiBuilderLimiter = createLimiter({
  windowMs: 60_000,
  max: 20,
  keyPrefix: "ai",
  message: "AI build rate limit exceeded. Please wait a moment before sending another request.",
});

// Publish/unpublish — 10 per minute per IP
export const publishLimiter = createLimiter({
  windowMs: 60_000,
  max: 10,
  keyPrefix: "publish",
  message: "Too many publish requests. Please wait before publishing again.",
});

// Export / duplicate — 15 per minute per IP
export const exportLimiter = createLimiter({
  windowMs: 60_000,
  max: 15,
  keyPrefix: "export",
  message: "Too many export or duplicate requests. Please wait before trying again.",
});

// General API — 300 per minute per IP (broad safety net)
export const generalLimiter = createLimiter({
  windowMs: 60_000,
  max: 300,
  keyPrefix: "general",
  message: "Too many requests. Please slow down.",
});
