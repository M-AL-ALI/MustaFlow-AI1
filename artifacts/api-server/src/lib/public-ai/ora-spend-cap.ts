/**
 * Ora daily spend caps — global, per-user, and per-IP anonymous limits.
 *
 * Wave 1C: in-memory counters are backed by a durable DB ledger
 * (ora_spend_ledger table). On startup, call initSpendLedger(pool) so caps
 * survive server restarts and deployments. DB writes are fire-and-forget and
 * never block the request path. If the DB is unavailable the module degrades
 * gracefully to in-memory-only mode and emits an ora_spend_ledger_degraded
 * structured warning.
 *
 * Wave 1D: multi-instance spend cap enforcement.
 * Route handlers call checkOraSpendCapAsync() instead of checkOraSpendCap().
 * When local in-memory usage reaches DB_VERIFY_THRESHOLD (80%) of any
 * applicable cap, a lightweight DB read resyncs in-memory counters from the
 * aggregate DB total before the cap decision is made. This closes the main
 * multi-instance overspend risk without adding a DB round-trip to every
 * request. A periodic background resync (default 2 min) further narrows the
 * window for low-traffic instances that drift behind the DB total.
 *
 * Fast path: requests below 80% of all applicable caps never hit the DB.
 * Fail-open: if the DB is unreachable at check time, in-memory caps remain
 * active and ora_spend_ledger_degraded is emitted once per UTC day.
 *
 * Four cap layers (orthogonal to per-user rolling-window quotas in ora-usage.ts):
 *   1. Global daily unit cap — total AI units across ALL users per UTC day.
 *   2. Per-user daily cap — AI units per authenticated userId per UTC day.
 *   3. Per-IP anonymous daily cap — units per IP for unauthenticated sessions.
 *   4. Per-feature unit counters — observability only; not enforced independently.
 *
 * ISOLATION: must NOT import from builder.ts, ai.ts, jobs.ts, or the credits
 * module — keeping Ora fully decoupled from the Builder's billing.
 */

import type { Pool } from "pg";
import { logger } from "../logger";

// ── Feature kinds and unit costs ───────────────────────────────────────────────

export type OraFeatureKind =
  | "chat"
  | "streaming_chat"
  | "file_analysis"
  | "dataset_analysis"
  | "image_analysis"
  | "tts_voice"
  | "realtime_voice"
  | "transcribe"
  | "file_generation"
  | "web_search"
  | "remember_document";

/**
 * Provider-cost weight per feature invocation (relative to one chat message = 1).
 * Higher-cost operations use more units to give the global cap correct proportional
 * coverage across feature mix.
 */
export const FEATURE_UNITS: Record<OraFeatureKind, number> = {
  chat: 1,
  streaming_chat: 1,
  file_analysis: 3,
  dataset_analysis: 5,
  image_analysis: 3,
  tts_voice: 1,
  // Realtime voice runs a continuous, bidirectional audio session. It is charged
  // once at session start as a bounded block (the route caps session duration by
  // tier) rather than per message. Priced like dataset_analysis to reflect the
  // continuous audio cost relative to a single text turn.
  realtime_voice: 5,
  transcribe: 1,
  file_generation: 3,
  web_search: 2,
  remember_document: 2,
};

// ── Cap constants (env-configurable, read lazily for test flexibility) ────────

/** Total AI units allowed across ALL users in a UTC calendar day. */
function globalDailyCap(): number {
  return parseInt(process.env.ORA_GLOBAL_DAILY_UNIT_CAP ?? "10000", 10);
}

/** AI units allowed per anonymous IP address in a UTC calendar day. */
function anonIpDailyCap(): number {
  return parseInt(process.env.ORA_ANON_IP_DAILY_UNIT_CAP ?? "50", 10);
}

/** AI units allowed per authenticated user ID in a UTC calendar day. */
function userDailyCap(): number {
  return parseInt(process.env.ORA_USER_DAILY_UNIT_CAP ?? "500", 10);
}

// ── Alert thresholds ──────────────────────────────────────────────────────────

/**
 * Thresholds at which structured warn logs are emitted.
 * Attach future alert integrations (PagerDuty, Slack, etc.) to
 * the ora_spend_cap_threshold structured log event.
 */
const ALERT_THRESHOLDS: readonly number[] = [0.5, 0.8, 0.95, 1.0];

/**
 * Emit structured warn logs when the global spend crosses a threshold band.
 * Only fires on crossing (prev < cutoff <= next), not on repeated calls above.
 */
function checkGlobalAlerts(prev: number, next: number, cap: number): void {
  if (cap <= 0) return;
  for (const t of ALERT_THRESHOLDS) {
    const cutoff = Math.ceil(cap * t);
    if (prev < cutoff && next >= cutoff) {
      logger.warn(
        {
          event: "ora_spend_cap_threshold",
          threshold: t,
          thresholdPct: Math.round(t * 100),
          globalUnits: next,
          globalCap: cap,
          resetAt: nextMidnightUtcIso(),
        },
        `Ora global daily spend at ${Math.round(t * 100)}% of cap — ${next}/${cap} units`,
      );
    }
  }
}

// ── Wave 1D: DB verification threshold ───────────────────────────────────────

/**
 * When local in-memory usage for any applicable cap dimension reaches this
 * fraction of the cap, checkOraSpendCapAsync forces a DB resync before the
 * cap decision. Below this threshold the fast in-memory path is used.
 *
 * Configurable via ORA_SPEND_DB_VERIFY_THRESHOLD (0–1). Defaults to 0.8.
 */
function dbVerifyThreshold(): number {
  const raw = process.env.ORA_SPEND_DB_VERIFY_THRESHOLD;
  if (!raw) return 0.8;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.8;
}

// ── Midnight-UTC daily state ──────────────────────────────────────────────────

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function nextMidnightUtcIso(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

interface DailyState {
  dateKey: string;
  globalUnits: number;
  userUnits: Map<string, number>;
  ipUnits: Map<string, number>;
  featureUnits: Map<OraFeatureKind, number>;
}

function buildFreshState(): DailyState {
  return {
    dateKey: utcDateKey(),
    globalUnits: 0,
    userUnits: new Map(),
    ipUnits: new Map(),
    featureUnits: new Map(),
  };
}

let _state: DailyState = buildFreshState();

/** Timer handle for the periodic background resync. Null when not running. */
let _syncIntervalHandle: ReturnType<typeof setInterval> | null = null;

/** Reset state — for tests only. Pass no argument to get a clean zero state. */
export function _resetSpendCapState(override?: DailyState): void {
  _state = override ?? buildFreshState();
  if (_syncIntervalHandle !== null) {
    clearInterval(_syncIntervalHandle);
    _syncIntervalHandle = null;
  }
}

/** Read the current state, auto-rolling to a fresh day at midnight UTC. */
function currentState(): DailyState {
  if (_state.dateKey !== utcDateKey()) {
    _state = buildFreshState();
  }
  return _state;
}

// ── Durable ledger pool ───────────────────────────────────────────────────────

let _ledgerPool: Pool | null = null;
let _ledgerInitialized = false;

/**
 * UTC date of the last ora_spend_ledger_degraded warning.
 * Rate-limits the warn to once per calendar day so logs stay readable.
 */
let _degradedWarnedAt = "";

/**
 * Inject a DB pool for durable spend ledger persistence.
 * Exposed for tests — production code calls initSpendLedger(pool) instead.
 */
export function _setLedgerPool(pool: Pool | null): void {
  _ledgerPool = pool;
  _ledgerInitialized = true;
}

/** Stop the periodic background resync. Exposed for tests. */
export function _stopPeriodicSync(): void {
  if (_syncIntervalHandle !== null) {
    clearInterval(_syncIntervalHandle);
    _syncIntervalHandle = null;
  }
}

function logDegraded(detail: string): void {
  const today = utcDateKey();
  if (_degradedWarnedAt === today) return;
  _degradedWarnedAt = today;
  logger.warn(
    { event: "ora_spend_ledger_degraded", detail },
    "Ora spend ledger DB unavailable — running in memory-only mode. " +
      "Caps will not survive restarts until the DB is reachable.",
  );
}

// ── DB upsert helper ──────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO ora_spend_ledger (date_key, ledger_key, units)
  VALUES ($1, $2, $3)
  ON CONFLICT (date_key, ledger_key)
  DO UPDATE SET
    units      = ora_spend_ledger.units + EXCLUDED.units,
    updated_at = now()
`;

/**
 * Persist a spend event to the DB ledger. Fire-and-forget — never blocks the
 * request path. Logs ora_spend_ledger_degraded (once per day) on failure.
 */
async function persistSpendToDB(
  dateKey: string,
  units: number,
  userId: string | null,
  ip: string | null,
  feature: OraFeatureKind,
): Promise<void> {
  if (!_ledgerInitialized || !_ledgerPool) return;
  const pool = _ledgerPool;
  const client = await pool.connect().catch(() => null);
  if (!client) {
    logDegraded("pool.connect() failed");
    return;
  }
  try {
    await client.query(UPSERT_SQL, [dateKey, "global", units]);
    if (userId) await client.query(UPSERT_SQL, [dateKey, `user:${userId}`, units]);
    if (ip) await client.query(UPSERT_SQL, [dateKey, `ip:${ip}`, units]);
    await client.query(UPSERT_SQL, [dateKey, `feature:${feature}`, units]);
  } catch (err) {
    logDegraded(err instanceof Error ? err.message : String(err));
  } finally {
    client.release();
  }
}

// ── Wave 1D: DB resync ────────────────────────────────────────────────────────

/**
 * Read today's DB totals and raise any in-memory counter that is lower than
 * the DB value (DB is the aggregate of all instances; take the maximum to
 * avoid lowering this instance's own fire-and-forget writes).
 *
 * Logs ora_spend_cap_db_override whenever a counter is raised, so operators
 * can see how often multi-instance divergence occurs.
 */
async function resyncFromDB(pool: Pool): Promise<void> {
  const dateKey = utcDateKey();
  const client = await pool.connect().catch(() => null);
  if (!client) {
    logDegraded("pool.connect() failed during resync");
    return;
  }
  try {
    const { rows } = await client.query<{ ledger_key: string; units: number }>(
      `SELECT ledger_key, units FROM ora_spend_ledger WHERE date_key = $1`,
      [dateKey],
    );

    const state = currentState();
    let raisedCount = 0;

    for (const row of rows) {
      const { ledger_key: key, units } = row;
      if (key === "global") {
        if (units > state.globalUnits) {
          logger.info(
            {
              event: "ora_spend_cap_db_override",
              dimension: "global",
              memoryUnits: state.globalUnits,
              dbUnits: units,
            },
            "Ora global spend counter raised from DB resync",
          );
          state.globalUnits = units;
          raisedCount++;
        }
      } else if (key.startsWith("user:")) {
        const uid = key.slice(5);
        const memVal = state.userUnits.get(uid) ?? 0;
        if (units > memVal) {
          logger.info(
            {
              event: "ora_spend_cap_db_override",
              dimension: "user",
              memoryUnits: memVal,
              dbUnits: units,
            },
            "Ora user spend counter raised from DB resync",
          );
          state.userUnits.set(uid, units);
          raisedCount++;
        }
      } else if (key.startsWith("ip:")) {
        const ip = key.slice(3);
        const memVal = state.ipUnits.get(ip) ?? 0;
        if (units > memVal) {
          state.ipUnits.set(ip, units);
          raisedCount++;
        }
      }
    }

    logger.debug(
      { event: "ora_spend_resync", rowCount: rows.length, raisedCount },
      "Ora spend ledger resynced from DB",
    );
  } catch (err) {
    logDegraded(err instanceof Error ? err.message : String(err));
  } finally {
    client.release();
  }
}

// ── Startup seed ──────────────────────────────────────────────────────────────

/**
 * Seed in-memory counters from the DB ledger for today's UTC date and start
 * the periodic background resync.
 *
 * Call this once at server startup, passing the shared DB pool. After seeding,
 * spend caps are restart-safe: counters reflect any spending that occurred
 * before the restart. The periodic resync (default 2 min) keeps counters
 * current when multiple API instances run concurrently.
 *
 * Also callable from tests with a mock pool to simulate a restart.
 */
export async function initSpendLedger(pool: Pool): Promise<void> {
  _ledgerPool = pool;
  _ledgerInitialized = true;

  const dateKey = utcDateKey();
  const client = await pool.connect().catch(() => null);
  if (!client) {
    logDegraded("pool.connect() failed during init");
    _startPeriodicResync(pool);
    return;
  }

  try {
    const { rows } = await client.query<{ ledger_key: string; units: number }>(
      `SELECT ledger_key, units FROM ora_spend_ledger WHERE date_key = $1`,
      [dateKey],
    );

    const state = buildFreshState();
    for (const row of rows) {
      const { ledger_key: key, units } = row;
      if (key === "global") {
        state.globalUnits = units;
      } else if (key.startsWith("user:")) {
        state.userUnits.set(key.slice(5), units);
      } else if (key.startsWith("ip:")) {
        state.ipUnits.set(key.slice(3), units);
      } else if (key.startsWith("feature:")) {
        const featureKey = key.slice(8);
        if (featureKey in FEATURE_UNITS) {
          state.featureUnits.set(featureKey as OraFeatureKind, units);
        }
      }
    }
    _state = state;

    logger.info(
      {
        event: "ora_spend_ledger_seeded",
        dateKey,
        rowCount: rows.length,
        globalUnits: state.globalUnits,
        userCount: state.userUnits.size,
        ipCount: state.ipUnits.size,
        featureCount: state.featureUnits.size,
      },
      "Ora spend ledger seeded from DB",
    );
  } catch (err) {
    logDegraded(err instanceof Error ? err.message : String(err));
  } finally {
    client.release();
  }

  _startPeriodicResync(pool);
}

function _startPeriodicResync(pool: Pool): void {
  if (_syncIntervalHandle !== null) clearInterval(_syncIntervalHandle);
  const intervalMs = parseInt(process.env.ORA_SPEND_RESYNC_INTERVAL_MS ?? "120000", 10);
  if (intervalMs <= 0) return;
  _syncIntervalHandle = setInterval(() => {
    void resyncFromDB(pool);
  }, intervalMs);
  if (typeof _syncIntervalHandle === "object" && _syncIntervalHandle !== null) {
    (_syncIntervalHandle as NodeJS.Timeout).unref?.();
  }
}

// ── Cap result type ───────────────────────────────────────────────────────────

export interface SpendCapResult {
  allowed: boolean;
  limitType: "daily_spend_cap";
  /** Why the request was blocked. "none" when allowed. */
  reason: "global_cap" | "user_cap" | "anon_ip_cap" | "none";
  units: number;
  /** ISO timestamp when daily counters reset (midnight UTC). */
  resetAt: string;
  /** Seconds until reset. 0 when allowed. */
  retryAfter: number;
  upgradeAvailable: boolean;
  /** User-safe error message — no provider detail, no Builder language. */
  message: string;
}

// ── Core check + consume ──────────────────────────────────────────────────────

import type { Request } from "express";

function requestIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

/**
 * Check whether this request is within all applicable daily spend caps.
 * When allowed, atomically increments the relevant in-memory counters and
 * schedules a fire-and-forget DB upsert to persist the spend.
 *
 * Synchronous fast path — reads in-memory counters only. Route handlers
 * should use checkOraSpendCapAsync() which adds DB verification at high usage.
 *
 * @param req     Express request — used for IP extraction and E2E bypass.
 * @param feature The Ora feature being invoked (determines unit cost).
 * @param userId  Authenticated user ID, or null for anonymous visitors.
 * @param tier    Plan tier ("anonymous" | "free" | "core" | "wave").
 */
export function checkOraSpendCap(
  req: Request,
  feature: OraFeatureKind,
  userId: string | null,
  tier: string,
): SpendCapResult {
  // E2E test bypass — never count automated test runs against prod caps.
  if (process.env.E2E_TEST_ENABLED === "true" && req.headers["x-e2e-test-user"]) {
    return allowed(feature, 0);
  }

  const units = FEATURE_UNITS[feature];
  const ip = requestIp(req);
  const cap = globalDailyCap();
  const uCap = userDailyCap();
  const ipCap = anonIpDailyCap();
  const resetAt = nextMidnightUtcIso();
  const retryAfter = Math.max(1, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));
  const state = currentState();
  const isAnon = !userId;
  const ipHash = ip.length >= 8 ? ip.slice(0, 8) : ip;

  // ── Check 1: Global daily cap ──────────────────────────────────────────────
  if (state.globalUnits + units > cap) {
    logger.warn(
      {
        event: "ora_spend_cap_blocked",
        reason: "global_cap",
        feature,
        units,
        globalUnits: state.globalUnits,
        globalCap: cap,
        tier,
        isAnon,
        ipHash,
      },
      "Ora global daily cap reached — request blocked",
    );
    return {
      allowed: false,
      limitType: "daily_spend_cap",
      reason: "global_cap",
      units,
      resetAt,
      retryAfter,
      upgradeAvailable: false,
      message:
        "Ora is at daily capacity. Service will resume at midnight UTC. Thank you for your patience.",
    };
  }

  // ── Check 2: Per-user daily cap (authenticated users only) ─────────────────
  if (!isAnon && userId) {
    const userUsed = state.userUnits.get(userId) ?? 0;
    if (userUsed + units > uCap) {
      logger.warn(
        {
          event: "ora_spend_cap_blocked",
          reason: "user_cap",
          feature,
          units,
          userUsed,
          userCap: uCap,
          tier,
          isAnon: false,
        },
        "Ora per-user daily cap reached — request blocked",
      );
      return {
        allowed: false,
        limitType: "daily_spend_cap",
        reason: "user_cap",
        units,
        resetAt,
        retryAfter,
        upgradeAvailable: true,
        message:
          "You have reached your daily Ora usage limit. Upgrade your plan or try again after midnight UTC.",
      };
    }
  }

  // ── Check 3: Per-IP anonymous daily cap ────────────────────────────────────
  if (isAnon) {
    const ipUsed = state.ipUnits.get(ip) ?? 0;
    if (ipUsed + units > ipCap) {
      logger.warn(
        {
          event: "ora_spend_cap_blocked",
          reason: "anon_ip_cap",
          feature,
          units,
          ipUsed,
          anonIpCap: ipCap,
          tier,
          isAnon: true,
          ipHash,
        },
        "Ora anonymous IP daily cap reached — request blocked",
      );
      return {
        allowed: false,
        limitType: "daily_spend_cap",
        reason: "anon_ip_cap",
        units,
        resetAt,
        retryAfter,
        upgradeAvailable: true,
        message:
          "You have reached your daily free usage limit. Sign in or create a free account to continue.",
      };
    }
  }

  // ── Consume (all checks passed) ────────────────────────────────────────────
  const prevGlobal = state.globalUnits;
  state.globalUnits += units;
  if (!isAnon && userId) {
    state.userUnits.set(userId, (state.userUnits.get(userId) ?? 0) + units);
  }
  if (isAnon) {
    state.ipUnits.set(ip, (state.ipUnits.get(ip) ?? 0) + units);
  }
  state.featureUnits.set(feature, (state.featureUnits.get(feature) ?? 0) + units);

  // Alert thresholds — structured warn logs for ops/future alert integrations.
  checkGlobalAlerts(prevGlobal, state.globalUnits, cap);

  // Persist to durable DB ledger (fire-and-forget — does not block response).
  void persistSpendToDB(state.dateKey, units, isAnon ? null : userId, isAnon ? ip : null, feature);

  return allowed(feature, units);
}

/**
 * Async variant of checkOraSpendCap for use in route handlers.
 *
 * When local in-memory usage for any applicable cap dimension is at or above
 * DB_VERIFY_THRESHOLD (default 80%), a DB resync is performed first so that
 * spending accumulated by other API instances is reflected before the
 * cap decision. Below the threshold the synchronous fast path is used directly.
 *
 * If the DB is unavailable the fast path is used unchanged (fail-open) and
 * ora_spend_ledger_degraded is emitted once per UTC day.
 */
export async function checkOraSpendCapAsync(
  req: Request,
  feature: OraFeatureKind,
  userId: string | null,
  tier: string,
): Promise<SpendCapResult> {
  // E2E bypass — fast path, no DB interaction.
  if (process.env.E2E_TEST_ENABLED === "true" && req.headers["x-e2e-test-user"]) {
    return allowed(feature, 0);
  }

  if (_ledgerInitialized && _ledgerPool) {
    const state = currentState();
    const cap = globalDailyCap();
    const uCap = userDailyCap();
    const ipCap = anonIpDailyCap();
    const ip = requestIp(req);
    const isAnon = !userId;
    const threshold = dbVerifyThreshold();

    const globalFloor = cap > 0 ? Math.floor(cap * threshold) : 0;
    const userFloor = uCap > 0 ? Math.floor(uCap * threshold) : 0;
    const ipFloor = ipCap > 0 ? Math.floor(ipCap * threshold) : 0;

    let needsDbCheck = state.globalUnits >= globalFloor;
    if (!needsDbCheck && !isAnon && userId) {
      needsDbCheck = (state.userUnits.get(userId) ?? 0) >= userFloor;
    }
    if (!needsDbCheck && isAnon) {
      needsDbCheck = (state.ipUnits.get(ip) ?? 0) >= ipFloor;
    }

    if (needsDbCheck) {
      await resyncFromDB(_ledgerPool);
    }
  }

  return checkOraSpendCap(req, feature, userId, tier);
}

function allowed(feature: OraFeatureKind, units: number): SpendCapResult {
  return {
    allowed: true,
    limitType: "daily_spend_cap",
    reason: "none",
    units,
    resetAt: nextMidnightUtcIso(),
    retryAfter: 0,
    upgradeAvailable: false,
    message: "",
  };
}

// ── Read-only snapshot (monitoring / tests) ───────────────────────────────────

export interface SpendCapSnapshot {
  dateKey: string;
  globalUnits: number;
  globalCap: number;
  userCap: number;
  anonIpCap: number;
  featureUnits: Partial<Record<OraFeatureKind, number>>;
  /** True when the durable DB ledger is active; false = memory-only mode. */
  ledgerActive: boolean;
  /** True when the periodic background resync timer is running. */
  periodicSyncActive: boolean;
}

/** Read-only view of the current day's counters. Safe to call from any thread. */
export function getSpendCapSnapshot(): SpendCapSnapshot {
  const state = currentState();
  return {
    dateKey: state.dateKey,
    globalUnits: state.globalUnits,
    globalCap: globalDailyCap(),
    userCap: userDailyCap(),
    anonIpCap: anonIpDailyCap(),
    featureUnits: Object.fromEntries(state.featureUnits.entries()),
    ledgerActive: _ledgerInitialized && _ledgerPool !== null,
    periodicSyncActive: _syncIntervalHandle !== null,
  };
}
