// ─────────────────────────────────────────────────────────────────────────────
// Minimal Upstash Redis REST client (no SDK dependency — uses global fetch).
//
// Used to back the sliding-window rate-limit counters with a shared store so
// per-IP limits survive process restarts and span multiple instances. This is
// strictly ADDITIVE: when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are
// absent (or any request fails), callers fall back to the in-memory limiter —
// so a Redis outage degrades gracefully instead of breaking request handling.
//
// Only fixed-window COUNTERS are distributed here. The AI concurrency semaphore
// (aiBuilderLimiter / oraLimiter) holds live HTTP connections open and is
// inherently per-process, so it intentionally stays in-memory.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** True when both Upstash REST credentials are configured. */
export function isRedisEnabled(): boolean {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

// Per-request timeout so a slow/hung Redis never blocks the request path; on
// timeout the caller's catch falls back to the in-memory limiter.
const REDIS_TIMEOUT_MS = 1_500;

/**
 * Execute a single Redis command via the Upstash REST API and return its
 * `result`. Throws on any transport/HTTP/Redis error so the caller can fall
 * back to the in-memory path.
 */
async function redisCommand(args: Array<string | number>): Promise<unknown> {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Redis not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(REDIS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Atomic fixed-window increment: INCR the key, and set its expiry only on the
// first increment so the whole window expires together. Returns the new count.
const INCR_WINDOW_LUA =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  "return c";

/**
 * Increment a fixed-window counter for `key` and return the new count. The key
 * expires after `windowMs`. Atomic via a single EVAL so concurrent requests
 * cannot lose the expiry. Throws on failure (caller falls back to memory).
 */
export async function redisIncrementWindow(key: string, windowMs: number): Promise<number> {
  const result = await redisCommand(["EVAL", INCR_WINDOW_LUA, 1, key, windowMs]);
  const count = typeof result === "number" ? result : Number(result);
  if (!Number.isFinite(count)) throw new Error("Redis returned a non-numeric count");
  return count;
}

let warnedUnavailable = false;

/** Log a one-time warning when Redis was expected but a command failed. */
export function noteRedisFallback(err: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn({ err: msg }, "Redis rate-limit backend unavailable — falling back to in-memory");
}
