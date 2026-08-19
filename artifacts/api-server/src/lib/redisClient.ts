// ─────────────────────────────────────────────────────────────────────────────
// Minimal Upstash Redis REST client (no SDK dependency — uses global fetch).
//
// Used to back fixed-window and admission counters with a shared store so
// per-IP limits survive process restarts and span multiple instances. This is
// additive for existing broad IP limits: they retain their memory fallback.
// Cost-bearing brainstorm admission deliberately fails closed on any missing
// binding or request failure, so an outage never becomes unmetered AI spend.
//
// Only fixed-window COUNTERS are distributed here. The AI concurrency semaphore
// (aiBuilderLimiter / oraLimiter) holds live HTTP connections open and is
// inherently per-process, so it intentionally stays in-memory.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger";
import { redisAdmissionBackendAvailable } from "./metrics";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

redisAdmissionBackendAvailable.set(0);

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
  if (!REDIS_URL || !REDIS_TOKEN) {
    redisAdmissionBackendAvailable.set(0);
    throw new Error("Redis not configured");
  }
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
    redisAdmissionBackendAvailable.set(1);
    return json.result;
  } catch (error) {
    redisAdmissionBackendAvailable.set(0);
    throw error;
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

export interface DualWindowAdmissionResult {
  allowed: boolean;
  blockedWindow: "hour" | "day" | null;
  hourCount: number;
  dayCount: number;
  hourResetAtMs: number;
  dayResetAtMs: number;
  serverNowMs: number;
}

// One hash per admission identity. Redis TIME makes bucket boundaries
// authoritative across API hosts. The prospective hour/day increment is
// committed to both counters or neither, so no partial reservation can leak.
export const RESERVE_DUAL_WINDOW_LUA = `
local now = redis.call('TIME')
local nowSec = tonumber(now[1])
local hourBucket = math.floor(nowSec / 3600)
local dayBucket = math.floor(nowSec / 86400)
local storedHourBucket = tonumber(redis.call('HGET', KEYS[1], 'hourBucket'))
local storedDayBucket = tonumber(redis.call('HGET', KEYS[1], 'dayBucket'))
local hourCount = tonumber(redis.call('HGET', KEYS[1], 'hourCount')) or 0
local dayCount = tonumber(redis.call('HGET', KEYS[1], 'dayCount')) or 0
if storedHourBucket ~= hourBucket then hourCount = 0 end
if storedDayBucket ~= dayBucket then dayCount = 0 end
local weight = tonumber(ARGV[3])
local nextHour = hourCount + weight
local nextDay = dayCount + weight
local hourReset = (hourBucket + 1) * 3600
local dayReset = (dayBucket + 1) * 86400
if nextHour > tonumber(ARGV[1]) then
  return {0, 1, hourCount, dayCount, hourReset, dayReset, nowSec}
end
if nextDay > tonumber(ARGV[2]) then
  return {0, 2, hourCount, dayCount, hourReset, dayReset, nowSec}
end
redis.call('HSET', KEYS[1],
  'hourBucket', hourBucket,
  'hourCount', nextHour,
  'dayBucket', dayBucket,
  'dayCount', nextDay)
redis.call('EXPIREAT', KEYS[1], dayReset + 3600)
return {1, 0, nextHour, nextDay, hourReset, dayReset, nowSec}
`;

/**
 * Atomically reserve weighted capacity from an hourly and daily ceiling.
 * Throws on missing bindings, transport, HTTP, Redis, or response-shape error;
 * cost-bearing callers must fail closed rather than taking the memory fallback.
 */
export async function reserveDualWindowAdmission(input: {
  key: string;
  hourlyLimit: number;
  dailyLimit: number;
  weight: number;
}): Promise<DualWindowAdmissionResult> {
  if (!isRedisEnabled()) throw new Error("Redis not configured");
  const result = await redisCommand([
    "EVAL",
    RESERVE_DUAL_WINDOW_LUA,
    1,
    input.key,
    input.hourlyLimit,
    input.dailyLimit,
    input.weight,
  ]);
  if (!Array.isArray(result) || result.length !== 7) {
    throw new Error("Redis returned an invalid admission result");
  }

  const values = result.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Redis returned a non-numeric admission result");
  }
  const [allowed, blockedWindow, hourCount, dayCount, hourReset, dayReset, serverNow] = values;
  if (![0, 1].includes(allowed) || ![0, 1, 2].includes(blockedWindow)) {
    throw new Error("Redis returned an out-of-range admission result");
  }

  return {
    allowed: allowed === 1,
    blockedWindow: blockedWindow === 1 ? "hour" : blockedWindow === 2 ? "day" : null,
    hourCount,
    dayCount,
    hourResetAtMs: hourReset * 1000,
    dayResetAtMs: dayReset * 1000,
    serverNowMs: serverNow * 1000,
  };
}

let warnedUnavailable = false;

/** Log a one-time warning when Redis was expected but a command failed. */
export function noteRedisFallback(err: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  logger.warn(
    { errorClass: err instanceof Error ? err.constructor.name : "UnknownError" },
    "Redis rate-limit backend unavailable — falling back to in-memory",
  );
}
