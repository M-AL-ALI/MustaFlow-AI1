/**
 * Thin Upstash Redis REST client using native fetch.
 * Returns null for every operation when UPSTASH_REDIS_REST_URL / TOKEN are absent
 * so callers can degrade gracefully to an in-memory fallback.
 */

const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

export const redisAvailable = Boolean(url && token);

async function command<T>(args: (string | number)[]): Promise<T | null> {
  if (!url || !token) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result: T };
    return json.result ?? null;
  } catch {
    return null;
  }
}

export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  await command(["SET", key, value, "EX", ttlSeconds]);
}

export async function redisGet(key: string): Promise<string | null> {
  return command<string>(["GET", key]);
}

export async function redisDel(key: string): Promise<void> {
  await command(["DEL", key]);
}
