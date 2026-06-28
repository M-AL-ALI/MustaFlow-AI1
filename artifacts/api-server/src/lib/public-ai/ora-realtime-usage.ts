/**
 * Ora LIVE-VOICE ("Talk to Ora") rolling-window minute metering.
 *
 * Realtime voice is metered by ACTUAL spoken SECONDS per subscription tier,
 * independent of the message/image budget in ora-usage.ts. The window opens on
 * the user's first charged second after a reset and refills exactly
 * TIER_ORA_WINDOW_HOURS later (free 5h, core 3h, wave 3h). Anonymous visitors
 * are metered with the free allowance under an "anon:"+hash usage key.
 *
 * Two tables back this module:
 *  - ora_realtime_usage_windows: one row per usage key, the budget ledger.
 *  - ora_realtime_sessions:      one row per minted session, for reconciliation,
 *                                concurrency (max 1 active/key) and stale expiry.
 *
 * CHARGE-ON-HEARTBEAT: each heartbeat applies an atomic delta of
 *   min(now - startedAt, maxDurationSeconds) - chargedSeconds
 * to the window, so overlapping/duplicate heartbeats can never lose or
 * double-count time, and a session can never charge past maxDurationSeconds.
 *
 * FAIL-CLOSED: the budget-gating paths (getRealtimeUsage, startRealtimeSession,
 * heartbeatRealtimeSession, endRealtimeSession) PROPAGATE DB errors so the route
 * can block voice with a 503 rather than fail open to unlimited audio. (Plain
 * text Ora is unaffected — it uses ora-usage.ts, which fails open on read.)
 *
 * ISOLATION: must NOT import from builder.ts, ai.ts, jobs.ts, or the credits
 * module — Ora voice never touches the Builder's billing.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  oraRealtimeUsageWindowsTable,
  oraRealtimeSessionsTable,
  TIER_ORA_REALTIME_LIMIT_SECONDS,
  TIER_ORA_WINDOW_HOURS,
  type SubscriptionTier,
  type OraRealtimeSession,
} from "@workspace/db";

/** Client heartbeat cadence; clients should beat at least this often. */
export const REALTIME_HEARTBEAT_INTERVAL_SECONDS = 30;
/**
 * A session with no heartbeat for longer than this is considered stale and is
 * finalized (status='expired') at lastHeartbeatAt + grace. 60s == two missed
 * 30s heartbeats.
 */
export const REALTIME_STALE_GRACE_SECONDS = 60;

/**
 * Per-session ceiling (seconds). A single session may use the full remaining
 * plan allowance, so this matches the per-window budget for each tier. The
 * effective cap is min(remainingSeconds, this), which therefore reduces to the
 * remaining budget; the budget window itself is the only ceiling on cumulative
 * voice time. (Heartbeat charging + stale-session expiry still bound the cost
 * of a forgotten/runaway tab to actual elapsed time within the budget.)
 */
export const TIER_ORA_REALTIME_SESSION_CAP_SECONDS: Record<SubscriptionTier, number> = {
  free: 1200, // 20 min (full free allowance)
  core: 3600, // 60 min (full core allowance)
  wave: 7200, // 120 min (full wave allowance)
};

/** Coerce an arbitrary tier string to a known tier, defaulting to "free". */
function tierKey(tier: string): SubscriptionTier {
  return tier === "core" || tier === "wave" ? tier : "free";
}

export interface RealtimeVoiceAllowance {
  tier: SubscriptionTier;
  limitSeconds: number;
  windowHours: number;
  sessionCapSeconds: number;
}

/** Static per-tier voice allowance (no DB access). */
export function getRealtimeVoiceAllowance(tier: string): RealtimeVoiceAllowance {
  const key = tierKey(tier);
  return {
    tier: key,
    limitSeconds: TIER_ORA_REALTIME_LIMIT_SECONDS[key],
    windowHours: TIER_ORA_WINDOW_HOURS[key],
    sessionCapSeconds: TIER_ORA_REALTIME_SESSION_CAP_SECONDS[key],
  };
}

export interface RealtimeUsageSnapshot {
  usedSeconds: number;
  limitSeconds: number;
  remainingSeconds: number;
  windowHours: number;
  /** When the current window opened (ISO), or null when no window is active. */
  windowStart: string | null;
  /** When the allowance refills (ISO), or null when no window is active. */
  resetsAt: string | null;
}

/**
 * Pure projection of a stored window row into a usage snapshot. A window that
 * has already elapsed is treated as fully reset (zero used, no active window)
 * WITHOUT writing — the next charge opens a fresh window.
 */
function projectUsage(
  row: { usedSeconds: number; windowStart: Date } | undefined,
  limit: number,
  windowHours: number,
): RealtimeUsageSnapshot {
  let used = 0;
  let windowStart: string | null = null;
  let resetsAt: string | null = null;
  if (row) {
    const start = row.windowStart;
    const endMs = start.getTime() + windowHours * 3_600_000;
    if (Date.now() < endMs) {
      used = row.usedSeconds;
      windowStart = start.toISOString();
      resetsAt = new Date(endMs).toISOString();
    }
  }
  return {
    usedSeconds: used,
    limitSeconds: limit,
    remainingSeconds: Math.max(0, limit - used),
    windowHours,
    windowStart,
    resetsAt,
  };
}

// Minimal executor surface shared by the pool db handle and a transaction.
type Executor = Pick<typeof db, "select" | "insert" | "update">;

/** Read the window ledger row for a usage key (no reset semantics applied). */
async function readWindowRow(
  exec: Executor,
  usageKey: string,
): Promise<{ usedSeconds: number; windowStart: Date } | undefined> {
  const [row] = await exec
    .select({
      usedSeconds: oraRealtimeUsageWindowsTable.usedSeconds,
      windowStart: oraRealtimeUsageWindowsTable.windowStart,
    })
    .from(oraRealtimeUsageWindowsTable)
    .where(eq(oraRealtimeUsageWindowsTable.usageKey, usageKey));
  return row ? { usedSeconds: row.usedSeconds, windowStart: row.windowStart as Date } : undefined;
}

/**
 * Read a usage key's current voice usage snapshot. THROWS on DB error so
 * callers gating audio can fail closed.
 */
export async function getRealtimeUsage(
  usageKey: string,
  tier: string,
): Promise<RealtimeUsageSnapshot> {
  const key = tierKey(tier);
  const limit = TIER_ORA_REALTIME_LIMIT_SECONDS[key];
  const windowHours = TIER_ORA_WINDOW_HOURS[key];
  const row = await readWindowRow(db, usageKey);
  return projectUsage(row, limit, windowHours);
}

/**
 * Atomically add `deltaSeconds` to a usage key's window, resetting the window
 * first if it has elapsed. Mirrors consumeOraQuota's reset-or-bump upsert but
 * adds a seconds delta instead of a +1 counter and has no limit guard (the cap
 * is enforced upstream via maxDurationSeconds). No-op for non-positive deltas.
 */
async function applyWindowCharge(
  exec: Executor,
  usageKey: string,
  deltaSeconds: number,
  windowHours: number,
): Promise<void> {
  if (deltaSeconds <= 0) return;
  const t = oraRealtimeUsageWindowsTable;
  const expired = sql`${t.windowStart} <= now() - (${windowHours} * interval '1 hour')`;
  await exec
    .insert(t)
    .values({ usageKey, windowStart: sql`now()`, usedSeconds: deltaSeconds })
    .onConflictDoUpdate({
      target: t.usageKey,
      set: {
        windowStart: sql`CASE WHEN ${expired} THEN now() ELSE ${t.windowStart} END`,
        usedSeconds: sql`CASE WHEN ${expired} THEN ${deltaSeconds} ELSE ${t.usedSeconds} + ${deltaSeconds} END`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Finalize one stale session inside an open transaction: charge the window up
 * to lastHeartbeatAt + grace (never past maxDurationSeconds) and mark the row
 * 'expired'. The caller is responsible for having SELECT ... FOR UPDATE-locked
 * the row.
 */
async function finalizeStaleSession(exec: Executor, s: OraRealtimeSession): Promise<void> {
  const windowHours = TIER_ORA_WINDOW_HOURS[tierKey(s.tier)];
  const graceEndMs = s.lastHeartbeatAt.getTime() + REALTIME_STALE_GRACE_SECONDS * 1000;
  const finalElapsed = Math.min(
    s.maxDurationSeconds,
    Math.max(0, Math.floor((graceEndMs - s.startedAt.getTime()) / 1000)),
  );
  const charged = Math.max(s.chargedSeconds, finalElapsed);
  const delta = charged - s.chargedSeconds;
  await applyWindowCharge(exec, s.usageKey, delta, windowHours);
  await exec
    .update(oraRealtimeSessionsTable)
    .set({ status: "expired", chargedSeconds: charged, updatedAt: sql`now()` })
    .where(eq(oraRealtimeSessionsTable.id, s.id));
}

/** SQL predicate: this session's last heartbeat is older than the grace window. */
function staleHeartbeatSql() {
  return sql`${oraRealtimeSessionsTable.lastHeartbeatAt} <= now() - (${REALTIME_STALE_GRACE_SECONDS} * interval '1 second')`;
}

/** Expire all stale active sessions for one usage key (inside a transaction). */
async function expireStaleForKey(exec: Executor, usageKey: string): Promise<void> {
  const stale = (await exec
    .select()
    .from(oraRealtimeSessionsTable)
    .where(
      and(
        eq(oraRealtimeSessionsTable.usageKey, usageKey),
        eq(oraRealtimeSessionsTable.status, "active"),
        staleHeartbeatSql(),
      ),
    )
    .for("update")) as OraRealtimeSession[];
  for (const s of stale) {
    await finalizeStaleSession(exec, s);
  }
}

export type StartRealtimeSessionResult =
  | {
      status: "ok";
      sessionId: string;
      maxDurationSeconds: number;
      remainingSeconds: number;
      limitSeconds: number;
      windowHours: number;
      resetsAt: string | null;
    }
  | { status: "over_limit"; remainingSeconds: 0; limitSeconds: number; resetsAt: string | null }
  | {
      status: "concurrent";
      remainingSeconds: number;
      limitSeconds: number;
      resetsAt: string | null;
    };

/**
 * Reserve a new realtime voice session for a usage key. Atomically: finalizes
 * stale sessions for the key, checks the rolling budget (429/over_limit when
 * exhausted), enforces max 1 concurrent active session (409/concurrent), then
 * inserts an active session capped at min(remaining, technical cap). Charging
 * happens later on heartbeat; the concurrency cap + per-session ceiling are what
 * bound total spend. THROWS on DB error (caller fails closed with 503).
 */
export async function startRealtimeSession(
  usageKey: string,
  tier: string,
): Promise<StartRealtimeSessionResult> {
  const key = tierKey(tier);
  const limit = TIER_ORA_REALTIME_LIMIT_SECONDS[key];
  const windowHours = TIER_ORA_WINDOW_HOURS[key];
  const cap = TIER_ORA_REALTIME_SESSION_CAP_SECONDS[key];
  return await db.transaction(async (tx) => {
    // Serialize concurrent starts for the SAME usage key. Without this, two
    // parallel /session calls could both observe "no active session" and both
    // INSERT, defeating the max-1-concurrent guarantee and double-spending the
    // budget. The xact-scoped advisory lock is released automatically at COMMIT.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${usageKey}))`);
    await expireStaleForKey(tx, usageKey);
    const snap = projectUsage(await readWindowRow(tx, usageKey), limit, windowHours);
    if (snap.remainingSeconds <= 0) {
      return {
        status: "over_limit",
        remainingSeconds: 0,
        limitSeconds: limit,
        resetsAt: snap.resetsAt,
      };
    }
    const active = await tx
      .select({ id: oraRealtimeSessionsTable.id })
      .from(oraRealtimeSessionsTable)
      .where(
        and(
          eq(oraRealtimeSessionsTable.usageKey, usageKey),
          eq(oraRealtimeSessionsTable.status, "active"),
          sql`${oraRealtimeSessionsTable.lastHeartbeatAt} > now() - (${REALTIME_STALE_GRACE_SECONDS} * interval '1 second')`,
        ),
      );
    if (active.length > 0) {
      return {
        status: "concurrent",
        remainingSeconds: snap.remainingSeconds,
        limitSeconds: limit,
        resetsAt: snap.resetsAt,
      };
    }
    const maxDurationSeconds = Math.min(snap.remainingSeconds, cap);
    const sessionId = randomUUID();
    await tx.insert(oraRealtimeSessionsTable).values({
      id: sessionId,
      usageKey,
      tier: key,
      maxDurationSeconds,
      chargedSeconds: 0,
      status: "active",
    });
    return {
      status: "ok",
      sessionId,
      maxDurationSeconds,
      remainingSeconds: snap.remainingSeconds,
      limitSeconds: limit,
      windowHours,
      resetsAt: snap.resetsAt,
    };
  });
}

export type RealtimeSessionTickResult =
  | {
      status: "active" | "ended" | "expired";
      remainingSeconds: number;
      chargedSeconds: number;
      limitSeconds: number;
      resetsAt: string | null;
      /** True when the session reached its cap and the client must stop audio. */
      ended: boolean;
    }
  | { status: "not_found" };

/**
 * Apply a heartbeat: charge the elapsed-but-uncharged delta to the window and
 * advance the session. Idempotent and safe under concurrent/duplicate beats —
 * the session row is locked FOR UPDATE and the delta is computed from the
 * authoritative server clock, so a repeated beat charges nothing. When elapsed
 * reaches maxDurationSeconds the session is marked 'ended' and the caller should
 * tear down. Ownership is verified via usageKey. THROWS on DB error.
 */
export async function heartbeatRealtimeSession(
  sessionId: string,
  usageKey: string,
  tier: string,
): Promise<RealtimeSessionTickResult> {
  const key = tierKey(tier);
  const limit = TIER_ORA_REALTIME_LIMIT_SECONDS[key];
  const windowHours = TIER_ORA_WINDOW_HOURS[key];
  return await db.transaction(async (tx) => {
    const [s] = (await tx
      .select()
      .from(oraRealtimeSessionsTable)
      .where(eq(oraRealtimeSessionsTable.id, sessionId))
      .for("update")) as OraRealtimeSession[];
    if (!s || s.usageKey !== usageKey) return { status: "not_found" };
    if (s.status !== "active") {
      const snap = projectUsage(await readWindowRow(tx, usageKey), limit, windowHours);
      return {
        status: s.status as "ended" | "expired",
        remainingSeconds: snap.remainingSeconds,
        chargedSeconds: s.chargedSeconds,
        limitSeconds: limit,
        resetsAt: snap.resetsAt,
        ended: true,
      };
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - s.startedAt.getTime()) / 1000));
    const capped = Math.min(elapsed, s.maxDurationSeconds);
    const delta = Math.max(0, capped - s.chargedSeconds);
    await applyWindowCharge(tx, usageKey, delta, windowHours);
    const ended = capped >= s.maxDurationSeconds;
    await tx
      .update(oraRealtimeSessionsTable)
      .set({
        chargedSeconds: capped,
        lastHeartbeatAt: sql`now()`,
        status: ended ? "ended" : "active",
        updatedAt: sql`now()`,
      })
      .where(eq(oraRealtimeSessionsTable.id, sessionId));
    const snap = projectUsage(await readWindowRow(tx, usageKey), limit, windowHours);
    return {
      status: ended ? "ended" : "active",
      remainingSeconds: snap.remainingSeconds,
      chargedSeconds: capped,
      limitSeconds: limit,
      resetsAt: snap.resetsAt,
      ended,
    };
  });
}

/**
 * Finalize a session on graceful client end. Idempotent: ending an already
 * ended/expired session just returns the current snapshot. The optional client
 * duration is clamped to [chargedSoFar, min(serverElapsed, maxDuration)] so a
 * client can neither inflate beyond the server clock nor refund below what was
 * already charged. THROWS on DB error.
 */
export async function endRealtimeSession(
  sessionId: string,
  usageKey: string,
  tier: string,
  clientDurationSeconds?: number,
): Promise<RealtimeSessionTickResult> {
  const key = tierKey(tier);
  const limit = TIER_ORA_REALTIME_LIMIT_SECONDS[key];
  const windowHours = TIER_ORA_WINDOW_HOURS[key];
  return await db.transaction(async (tx) => {
    const [s] = (await tx
      .select()
      .from(oraRealtimeSessionsTable)
      .where(eq(oraRealtimeSessionsTable.id, sessionId))
      .for("update")) as OraRealtimeSession[];
    if (!s || s.usageKey !== usageKey) return { status: "not_found" };
    if (s.status !== "active") {
      const snap = projectUsage(await readWindowRow(tx, usageKey), limit, windowHours);
      return {
        status: s.status as "ended" | "expired",
        remainingSeconds: snap.remainingSeconds,
        chargedSeconds: s.chargedSeconds,
        limitSeconds: limit,
        resetsAt: snap.resetsAt,
        ended: true,
      };
    }
    const serverElapsed = Math.max(0, Math.floor((Date.now() - s.startedAt.getTime()) / 1000));
    const serverCap = Math.min(serverElapsed, s.maxDurationSeconds);
    let target = serverCap;
    if (clientDurationSeconds != null && Number.isFinite(clientDurationSeconds)) {
      target = Math.min(Math.max(0, Math.floor(clientDurationSeconds)), serverCap);
    }
    const charged = Math.max(s.chargedSeconds, target);
    const delta = charged - s.chargedSeconds;
    await applyWindowCharge(tx, usageKey, delta, windowHours);
    await tx
      .update(oraRealtimeSessionsTable)
      .set({
        chargedSeconds: charged,
        lastHeartbeatAt: sql`now()`,
        status: "ended",
        updatedAt: sql`now()`,
      })
      .where(eq(oraRealtimeSessionsTable.id, sessionId));
    const snap = projectUsage(await readWindowRow(tx, usageKey), limit, windowHours);
    return {
      status: "ended",
      remainingSeconds: snap.remainingSeconds,
      chargedSeconds: charged,
      limitSeconds: limit,
      resetsAt: snap.resetsAt,
      ended: true,
    };
  });
}

/**
 * Background sweep: finalize every stale active session across all keys. Safe to
 * call periodically. Returns the number of sessions finalized. Best-effort —
 * THROWS on DB error so a scheduler can log/retry.
 */
export async function sweepStaleRealtimeSessions(): Promise<number> {
  return await db.transaction(async (tx) => {
    const stale = (await tx
      .select()
      .from(oraRealtimeSessionsTable)
      .where(and(eq(oraRealtimeSessionsTable.status, "active"), staleHeartbeatSql()))
      .for("update")) as OraRealtimeSession[];
    for (const s of stale) {
      await finalizeStaleSession(tx, s);
    }
    return stale.length;
  });
}
