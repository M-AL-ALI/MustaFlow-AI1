import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// Resolve the pool ceiling from PG_POOL_MAX, clamped to a sane positive integer so
// a misconfigured env var can never produce NaN, 0, or an absurd connection count.
function resolvePoolMax(): number {
  const raw = Number(process.env.PG_POOL_MAX);
  if (!Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Explicit pool ceiling (matches pg's default of 10) so behavior is predictable.
  max: resolvePoolMax(),
  // Keep idle clients around a little longer than pg's 10s default; combined with
  // keepAlive this avoids a churn of reconnects on a mostly-idle server.
  idleTimeoutMillis: 30_000,
  // Fail a connection attempt after 10s instead of pg's default of waiting forever,
  // so a transiently unreachable DB surfaces a fast, retryable error.
  connectionTimeoutMillis: 10_000,
  // Send TCP keepalive probes so the network layer (NAT / load balancer / managed
  // Postgres idle timeout) does not silently drop idle connections. Without this,
  // a dropped idle socket only surfaces as "Connection terminated unexpectedly" the
  // next time the client is reused.
  keepAlive: true,
});

// node-postgres emits 'error' on *idle* clients when the server or network drops
// the connection out from under the pool. With no listener attached, Node treats
// it as an unhandled error event and can crash the process. Log it and let the
// pool transparently recycle the dead client on the next checkout.
pool.on("error", (err) => {
  // lib/db is a low-level shared library with no pino logger available; this is a
  // last-resort error path, so console.error is intentional here.
  console.error("[db] idle postgres client error (pool will recycle):", err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./help-center-seed";
