// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting middleware — Phase 4 abuse protection.
//
// Uses a simple in-memory store (sufficient for single-process dev/prod on Replit).
// Each limiter stores per-IP counters with a TTL matching the window.
//
// JSON 429 responses are returned when hard limits are exceeded.
//
// The AI builder limiter uses a real deferred-request queue:
//   - Up to MAX_CONCURRENT AI calls are processed concurrently per IP.
//   - When at capacity, over-limit requests are placed in a FIFO pending queue.
//     Their HTTP connections are held open (long-poll style) until a slot frees.
//   - releaseSlot() is called when a response finishes. It drains the next
//     pending entry by calling its next() function — so the route handler runs
//     only after an actual concurrent slot becomes available.
//   - If the pending queue would exceed MAX_QUEUED, a hard 429 is returned.
//   - If a queued request waits longer than QUEUE_TIMEOUT_MS, it receives a 429.
// ─────────────────────────────────────────────────────────────────────────────

import type { Request, Response, NextFunction } from "express";
import { isRedisEnabled, redisIncrementWindow, noteRedisFallback } from "./redisClient";
import { logger } from "./logger";

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

interface LimiterOpts {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
  limitType?: string;
  upgradeAvailable?: boolean;
}

function clientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

// Apply the limit decision: set headers, then 429 or next() based on `count`.
// `resetAtMs` is the wall-clock time the current window ends.
function applyDecision(
  res: Response,
  next: NextFunction,
  opts: LimiterOpts,
  count: number,
  resetAtMs: number,
): void {
  res.setHeader("X-RateLimit-Limit", opts.max);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, opts.max - count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(resetAtMs / 1000));

  if (count > opts.max) {
    const body: Record<string, unknown> = {
      error: opts.message ?? "Too many requests. Please slow down and try again.",
      retryAfter: Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000)),
      resetAt: new Date(resetAtMs).toISOString(),
    };
    if (opts.limitType !== undefined) body.limitType = opts.limitType;
    if (opts.upgradeAvailable !== undefined) body.upgradeAvailable = opts.upgradeAvailable;
    res.status(429).json(body);
    return;
  }
  next();
}

// In-memory fixed-window limiter — the original, fully-synchronous path. Used
// when Redis is not configured and as the graceful fallback on any Redis error.
function memoryLimiter(req: Request, res: Response, next: NextFunction, opts: LimiterOpts): void {
  const key = `${opts.keyPrefix}:${clientIp(req)}`;
  const now = Date.now();

  let win = store.get(key);
  if (!win || win.resetAt <= now) {
    win = { count: 0, resetAt: now + opts.windowMs };
    store.set(key, win);
  }
  win.count += 1;
  applyDecision(res, next, opts, win.count, win.resetAt);
}

// Distributed fixed-window limiter backed by Upstash Redis. Falls back to the
// in-memory limiter if the Redis command fails for any reason.
async function redisLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
  opts: LimiterOpts,
): Promise<void> {
  // Bucket the window so all instances agree on the same counter + expiry.
  const bucket = Math.floor(Date.now() / opts.windowMs);
  const resetAtMs = (bucket + 1) * opts.windowMs;
  const key = `rl:${opts.keyPrefix}:${clientIp(req)}:${bucket}`;
  try {
    const count = await redisIncrementWindow(key, opts.windowMs);
    applyDecision(res, next, opts, count, resetAtMs);
  } catch (err) {
    noteRedisFallback(err);
    memoryLimiter(req, res, next, opts);
  }
}

function createLimiter(opts: LimiterOpts) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // When Redis isn't configured, stay on the original synchronous path so
    // behaviour (and existing tests) are byte-for-byte unchanged.
    if (!isRedisEnabled()) {
      memoryLimiter(req, res, next, opts);
      return;
    }
    void redisLimiter(req, res, next, opts);
  };
}

// ── Real deferred-request queue ────────────────────────────────────────────────
// When all concurrent AI slots are occupied, new requests are placed in a
// FIFO pending queue. Their HTTP connections stay open until:
//   a) a slot frees (releaseSlot drains the next pending entry via next()), or
//   b) QUEUE_TIMEOUT_MS elapses (they receive a 429).
//
// This provides actual deferred execution — queued jobs do not start until
// a real concurrent slot is available.

const MAX_CONCURRENT = 3; // simultaneous AI calls per IP before queuing kicks in
const MAX_QUEUED = 5; // pending requests allowed per IP before hard 429
const QUEUE_TIMEOUT_MS = 60_000; // max wait in queue (ms) before 429

interface PendingEntry {
  nextFn: NextFunction;
  res: Response;
  position: number;
  timer: ReturnType<typeof setTimeout>;
  closed?: boolean;
  detachQueuedListeners?: () => void;
}

interface SemaphoreEntry {
  active: number;
  pending: PendingEntry[];
}

const semaphoreStore = new Map<string, SemaphoreEntry>();

type ReleaseReason = "finish" | "close";

function isBuilderSemaphore(key: string): boolean {
  return key.startsWith("ai_sem:");
}

function logBuilderSemaphore(
  event: "release" | "queue-drain",
  fields: Record<string, string | number>,
): void {
  logger.info(
    {
      component: "ai-builder-limiter",
      event,
      ...fields,
    },
    "AI builder semaphore event",
  );
}

function attachBuilderRelease(key: string, res: Response): void {
  let released = false;

  const release = (reason: ReleaseReason): void => {
    if (released) return;
    released = true;
    res.off("finish", onFinish);
    res.off("close", onClose);
    releaseSlot(key, reason);
  };
  const onFinish = (): void => release("finish");
  const onClose = (): void => release("close");

  res.once("finish", onFinish);
  res.once("close", onClose);
}

function removeQueuedEntry(key: string, pending: PendingEntry): void {
  if (pending.closed) return;
  pending.closed = true;
  clearTimeout(pending.timer);
  pending.detachQueuedListeners?.();

  const entry = semaphoreStore.get(key);
  if (!entry) return;
  entry.pending = entry.pending.filter((candidate) => candidate !== pending);
  if (entry.active === 0 && entry.pending.length === 0) {
    semaphoreStore.delete(key);
  }
}

function releaseSlot(key: string, reason: ReleaseReason = "finish"): void {
  const entry = semaphoreStore.get(key);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  if (isBuilderSemaphore(key)) {
    logBuilderSemaphore("release", {
      reason,
      active: entry.active,
      queued: entry.pending.length,
    });
  }
  // Drain the next waiting request (skip any whose response already closed)
  while (entry.pending.length > 0) {
    const pend = entry.pending.shift()!;
    clearTimeout(pend.timer);
    pend.detachQueuedListeners?.();
    const builderSemaphore = isBuilderSemaphore(key);
    const responseState = builderSemaphore
      ? (pend.res as Response & {
          destroyed?: boolean;
          writableEnded?: boolean;
        })
      : undefined;
    const canDrain = builderSemaphore
      ? !pend.closed &&
        !pend.res.headersSent &&
        !responseState?.destroyed &&
        !responseState?.writableEnded
      : !pend.res.headersSent;
    if (canDrain) {
      entry.active += 1;
      if (builderSemaphore) {
        attachBuilderRelease(key, pend.res);
        logBuilderSemaphore("queue-drain", {
          position: pend.position,
          active: entry.active,
          queued: entry.pending.length,
        });
      } else {
        pend.res.once("finish", () => releaseSlot(key));
      }
      pend.nextFn();
      return;
    }
    // Timed-out entry — skip and try next
  }
  // Clean up idle entries
  if (entry.active === 0 && entry.pending.length === 0) {
    semaphoreStore.delete(key);
  }
}

export const aiBuilderLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const key = `ai_sem:${ip}`;

  let entry = semaphoreStore.get(key);
  if (!entry) {
    entry = { active: 0, pending: [] };
    semaphoreStore.set(key, entry);
  }

  res.setHeader("X-AI-Active", entry.active);
  res.setHeader("X-AI-Queued", entry.pending.length);

  if (entry.active < MAX_CONCURRENT) {
    // Slot available — proceed immediately.
    entry.active += 1;
    attachBuilderRelease(key, res);
    next();
    return;
  }

  // At capacity — reject if queue is full.
  if (entry.pending.length >= MAX_QUEUED) {
    res.status(429).json({
      error: "Too many AI requests queued. Please wait for current builds to finish.",
      retryAfter: 60,
    });
    return;
  }

  // Queue the request. The HTTP connection stays open; next() is called by
  // releaseSlot() when a concurrent slot becomes available.
  const position = entry.pending.length + 1;
  req.queuePosition = position;

  res.setHeader("X-Queue-Position", position);
  res.setHeader("X-Estimated-Wait-Ms", position * 20_000);

  const timer = setTimeout(() => {
    removeQueuedEntry(key, pendingEntry);
    if (!res.headersSent) {
      res.status(429).json({
        error: "Queue wait timeout. Too many concurrent AI builds in progress. Please try again.",
        retryAfter: 60,
      });
    }
  }, QUEUE_TIMEOUT_MS);

  // `let` so the variable is captured by the timer closure above.
  // eslint-disable-next-line prefer-const
  let pendingEntry: PendingEntry;
  const onQueuedClose = (): void => removeQueuedEntry(key, pendingEntry);
  const onQueuedAbort = (): void => removeQueuedEntry(key, pendingEntry);
  pendingEntry = {
    nextFn: next,
    res,
    position,
    timer,
    closed: false,
    detachQueuedListeners: () => {
      res.off("close", onQueuedClose);
      req.off("aborted", onQueuedAbort);
    },
  };
  res.once("close", onQueuedClose);
  req.once("aborted", onQueuedAbort);
  entry.pending.push(pendingEntry);
  // Do NOT call next() here — the request physically waits until releaseSlot() drains it.
};

// Domain verify — configurable limiter factory (used by domains.ts)
export const createLimiterForDomainVerify = createLimiter;

// ── Ora public AI limiters ─────────────────────────────────────────────────────
// IMPORTANT: Ora uses completely separate semaphore keys and rate limit keys
// from the Builder (ai_sem:) so public visitor traffic never contends with
// paying Builder users for concurrent AI slots.

const ORA_MAX_CONCURRENT = 2;
const ORA_MAX_QUEUED = 3;
const ORA_QUEUE_TIMEOUT_MS = 45_000;

export const oraLimiter = (req: Request, res: Response, next: NextFunction): void => {
  // Bypass the concurrency gate for E2E test requests so benchmark runs do not
  // stall each other behind the ORA_MAX_CONCURRENT=2 slot limit.
  if (process.env.E2E_TEST_ENABLED === "true" && req.headers["x-e2e-test-user"]) {
    next();
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const key = `ora_sem:${ip}`;

  let entry = semaphoreStore.get(key);
  if (!entry) {
    entry = { active: 0, pending: [] };
    semaphoreStore.set(key, entry);
  }

  if (entry.active < ORA_MAX_CONCURRENT) {
    entry.active += 1;
    res.once("finish", () => releaseSlot(key));
    next();
    return;
  }

  if (entry.pending.length >= ORA_MAX_QUEUED) {
    res.status(429).json({
      error: "Ora is busy right now. Please try again in a moment.",
      retryAfter: 30,
    });
    return;
  }

  const position = entry.pending.length + 1;

  const timer = setTimeout(() => {
    const e = semaphoreStore.get(key);
    if (e) e.pending = e.pending.filter((p) => p !== pendingEntry);
    if (!res.headersSent) {
      res.status(429).json({
        error: "Ora is taking too long to respond. Please try again.",
        retryAfter: 30,
      });
    }
  }, ORA_QUEUE_TIMEOUT_MS);

  // eslint-disable-next-line prefer-const
  let pendingEntry: PendingEntry;
  pendingEntry = { nextFn: next, res, position, timer };
  entry.pending.push(pendingEntry);
};

// Sliding-window counter: 10 Ora session creations per IP per 24h
export const oraSessionLimiter = createLimiter({
  windowMs: 24 * 60 * 60_000,
  max: 10,
  keyPrefix: "ora_session",
  message: "You have started too many Ora sessions today. Please try again tomorrow.",
});

// Sliding-window counter: 10 file uploads per IP per hour
// Separate key prefix from session and chat limiters so uploads don't block chat.
export const oraUploadLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 10,
  keyPrefix: "ora_upload",
  message: "You have uploaded too many files recently. Please wait before uploading again.",
});

// Voice Conversation Mode transcription uses short push-to-talk clips. Keep it
// separate from file uploads so a normal Talk to Ora session does not exhaust
// the generic upload bucket after a few turns.
export const oraVoiceTranscribeLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 60,
  keyPrefix: "ora_voice_transcribe",
  message: "Voice transcription is temporarily at capacity. Please wait before trying again.",
});

// Natural voice replies for Talk to Ora. Separate from text chat and uploads so
// users can have a real voice discussion without consuming unrelated buckets.
export const oraVoiceTtsLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 60,
  keyPrefix: "ora_voice_tts",
  message: "Ora voice replies are temporarily at capacity. Please wait before trying again.",
});

// Realtime "Talk to Ora" session mints. Each call issues a short-lived ephemeral
// OpenAI token for a bounded, continuous audio session — far more expensive than
// a text turn — so it gets its own stricter bucket to prevent reconnect abuse.
export const oraRealtimeSessionLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 6,
  keyPrefix: "ora_realtime_session",
  message: "You have started too many voice sessions recently. Please wait before trying again.",
});

// Realtime voice heartbeat/end ticks. These fire on a ~30s cadence for the life
// of a session plus a final end, so the bucket is generous (one active session
// is ~2/min) but still bounds a client spamming the metering endpoints.
export const oraRealtimeSessionTickLimiter = createLimiter({
  windowMs: 60_000,
  max: 60,
  keyPrefix: "ora_realtime_tick",
  message: "Too many voice session updates. Please slow down.",
});

// Sliding-window counter: 10 image uploads per IP per hour (images only)
export const oraImageUploadLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 10,
  keyPrefix: "ora_image_upload",
  message: "You have uploaded too many images recently. Please wait before uploading again.",
});

// Sliding-window counter: 6 image-analysis calls per IP per hour
// Stricter than uploads since each call invokes the premium vision model.
export const oraImageAnalysisLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 6,
  keyPrefix: "ora_image_analysis",
  message:
    "Image analysis is temporarily at capacity. Please try again later or describe your question in text instead.",
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

// Sliding-window counter: 5 handoff-create calls per IP per hour.
// Stricter than chat since each call invokes an AI model for summarization.
export const oraHandoffLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  keyPrefix: "ora_handoff",
  message:
    "Too many Builder handoff requests. Please wait before trying again, or describe your idea directly in the Builder.",
});

// File analysis: 5 per IP per hour. Each call runs a full AI model pass over
// a user document — stricter than uploads since the AI cost is higher.
export const oraFileAnalysisLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  keyPrefix: "ora_file_analysis",
  limitType: "file_analysis",
  upgradeAvailable: true,
  message: "File analysis is temporarily at capacity. Please try again later.",
});

// Dataset analysis: 3 per IP per hour. Highest-cost analysis route — each
// call processes structured tabular data through a premium model.
export const oraDatasetAnalysisLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 3,
  keyPrefix: "ora_dataset_analysis",
  limitType: "dataset_analysis",
  upgradeAvailable: true,
  message: "Dataset analysis is temporarily at capacity. Please try again later.",
});

// File generation: 5 per IP per hour. Each call generates a new file (PDF,
// CSV, code, etc.) via an AI model and stores it in the asset store.
export const oraGenerateFileLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  keyPrefix: "ora_generate_file",
  limitType: "file_generation",
  upgradeAvailable: true,
  message: "File generation is temporarily at capacity. Please try again later.",
});

// Deterministic file export — 30 per IP per hour. No AI/quota is consumed, but
// each call runs CPU/memory-heavy Office/PDF builders, so frequency is bounded
// to prevent abuse from cheaply-minted anonymous sessions.
export const oraExportFileLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 30,
  keyPrefix: "ora_export_file",
  limitType: "file_export",
  message: "File export is temporarily at capacity. Please try again later.",
});

// Help Center support chat — 20 messages per IP per minute. Each call invokes
// an AI model, so this is stricter than the general limiter but lenient enough
// for a normal back-and-forth support conversation.
export const supportChatLimiter = createLimiter({
  windowMs: 60_000,
  max: 20,
  keyPrefix: "support_chat",
  message: "Too many support messages. Please wait a moment before sending another.",
});

// Help Center escalation (ticket creation) — 5 per IP per hour. Stricter than
// chat to prevent ticket spam while still allowing legitimate follow-ups.
export const supportEscalateLimiter = createLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  keyPrefix: "support_escalate",
  message: "Too many support requests. Please wait before opening another ticket.",
});

// General API — 300 per minute per IP (broad safety net)
export const generalLimiter = createLimiter({
  windowMs: 60_000,
  max: 300,
  keyPrefix: "general",
  message: "Too many requests. Please slow down.",
});
