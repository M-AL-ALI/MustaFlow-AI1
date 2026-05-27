/**
 * Store for mid-run steering hints submitted by the user while a build task is
 * in progress. The agent loop polls this store between steps.
 *
 * When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, hints are
 * persisted in Redis with a 10-minute TTL so they survive API server restarts.
 * When Redis is absent the module falls back to an in-memory Map (original
 * behaviour), which is fine for single-process / dev environments.
 */

import { redisAvailable, redisSet, redisGet, redisDel } from "./redis";

const HINT_TTL_SECONDS = 600; // 10 minutes

function redisKey(taskId: number): string {
  return `steering:hint:${taskId}`;
}

// In-memory fallback
const memStore = new Map<number, string>();

export async function setSteeringHint(taskId: number, hint: string): Promise<void> {
  const value = hint.trim().slice(0, 2000);
  if (redisAvailable) {
    await redisSet(redisKey(taskId), value, HINT_TTL_SECONDS);
    return;
  }
  memStore.set(taskId, value);
}

export async function consumeSteeringHint(taskId: number): Promise<string | null> {
  if (redisAvailable) {
    const key = redisKey(taskId);
    const hint = await redisGet(key);
    if (hint !== null) await redisDel(key);
    return hint;
  }
  const hint = memStore.get(taskId) ?? null;
  if (hint !== null) memStore.delete(taskId);
  return hint;
}
