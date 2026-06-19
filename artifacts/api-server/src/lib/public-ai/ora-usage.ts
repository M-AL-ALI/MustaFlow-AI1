/**
 * Ora rolling-window usage metering.
 *
 * Ora is a STANDALONE assistant metered by per-user ROLLING TIME WINDOWS per
 * subscription tier — NOT by the AI Builder credit wallet, and NOT by a shared
 * midnight-UTC clock. The window opens on the user's FIRST metered action after
 * a reset; the full allowance refills exactly TIER_ORA_WINDOW_HOURS later.
 * Messages and images share ONE window timer per user (they refill together).
 * This module is the single source of truth for reading/consuming a signed-in
 * user's Ora usage. Anonymous visitors are metered separately by the JWT session
 * cap (see session.ts) and never touch this table.
 *
 * ISOLATION: must NOT import from builder.ts, ai.ts, jobs.ts, or the credits
 * module — keeping Ora fully decoupled from the Builder's billing.
 */
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import {
  db,
  oraUsageWindowsTable,
  TIER_ORA_MESSAGE_LIMIT,
  TIER_ORA_IMAGE_LIMIT,
  TIER_ORA_WINDOW_HOURS,
  type SubscriptionTier,
} from "@workspace/db";
import { MSG_LIMIT_VALUE } from "./session";

/** Coerce an arbitrary tier string to a known tier, defaulting to "free". */
function tierKey(tier: string): SubscriptionTier {
  return tier === "core" || tier === "wave" ? tier : "free";
}

/** The rolling window length (in hours) for a tier. */
export function oraWindowHours(tier: string): number {
  return TIER_ORA_WINDOW_HOURS[tierKey(tier)];
}

/** ISO timestamp marking when a window that opened at `start` fully refills. */
function resetsAtIso(start: Date, windowHours: number): string {
  return new Date(start.getTime() + windowHours * 3_600_000).toISOString();
}

export type OraQuotaKind = "message" | "image";

export interface OraUsageSnapshot {
  messageCount: number;
  imageCount: number;
  messageLimit: number;
  imageLimit: number;
  windowHours: number;
  /** When the current window opened (ISO), or null when no window is active. */
  windowStart: string | null;
  /** When the allowance refills (ISO), or null when no window is active. */
  resetsAt: string | null;
}

export interface OraQuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
  kind: OraQuotaKind;
  /** When the allowance refills (ISO), or null when no window is active. */
  resetsAt: string | null;
}

/**
 * Read the user's current rolling-window Ora usage, plus the limits for their
 * tier. A stored window that has already elapsed is treated as fully reset
 * (zeroed counts, no active window) without writing — the next consume opens a
 * fresh window. Returns zeroed counts when the table is unavailable (fail-open
 * on read; enforcement still happens against the tier limit on consume).
 */
export async function getOraUsage(userId: string, tier: string): Promise<OraUsageSnapshot> {
  const key = tierKey(tier);
  const windowHours = TIER_ORA_WINDOW_HOURS[key];
  let messageCount = 0;
  let imageCount = 0;
  let windowStart: string | null = null;
  let resetsAt: string | null = null;
  try {
    const [row] = await db
      .select({
        messageCount: oraUsageWindowsTable.messageCount,
        imageCount: oraUsageWindowsTable.imageCount,
        windowStart: oraUsageWindowsTable.windowStart,
      })
      .from(oraUsageWindowsTable)
      .where(eq(oraUsageWindowsTable.userId, userId));
    if (row) {
      const start = row.windowStart as Date;
      const windowEndMs = start.getTime() + windowHours * 3_600_000;
      // Only count usage from a window that is still open; an elapsed window is
      // already refilled (the next consume resets it).
      if (Date.now() < windowEndMs) {
        messageCount = row.messageCount;
        imageCount = row.imageCount;
        windowStart = start.toISOString();
        resetsAt = new Date(windowEndMs).toISOString();
      }
    }
  } catch {
    // ora_usage_windows may be unavailable in some envs — treat as zero usage.
  }
  return {
    messageCount,
    imageCount,
    messageLimit: TIER_ORA_MESSAGE_LIMIT[key],
    imageLimit: TIER_ORA_IMAGE_LIMIT[key],
    windowHours,
    windowStart,
    resetsAt,
  };
}

/**
 * Check whether the user is still under their window quota for the given bucket.
 * Does not mutate — call consumeOraQuota to actually reserve a slot.
 */
export async function checkOraQuota(
  userId: string,
  tier: string,
  kind: OraQuotaKind,
): Promise<OraQuotaResult> {
  const usage = await getOraUsage(userId, tier);
  const used = kind === "image" ? usage.imageCount : usage.messageCount;
  const limit = kind === "image" ? usage.imageLimit : usage.messageLimit;
  return { allowed: used < limit, used, limit, kind, resetsAt: usage.resetsAt };
}

/**
 * Atomically reserve one unit of the user's current rolling window for the given
 * bucket. Combines the window-reset, check and increment into a SINGLE SQL
 * statement so concurrent requests can never overshoot the tier limit.
 *
 * Semantics (one row per user, keyed on user_id):
 *  - No row yet → INSERT a row with window_start = now() and this counter = 1
 *    (allowed; opens the window).
 *  - Row's window has elapsed → RESET: window_start = now(), this counter = 1,
 *    the other counter = 0 (allowed; opens a fresh window).
 *  - Row's window is active and this counter < limit → bump it (allowed).
 *  - Row's window is active and this counter >= limit → setWhere excludes the
 *    row, nothing is written, RETURNING is empty (NOT allowed).
 *
 * Callers MUST refund (see refundOraQuota) on any path where the metered action
 * does not actually complete (model failure, capability not configured, etc.),
 * preserving the "a failed generation never costs the user" guarantee while
 * still reserving the slot for the duration of the request.
 *
 * Fail-open on DB error: if the usage table is unavailable we allow the request
 * rather than hard-blocking Ora (matches the read-path degradation elsewhere).
 */
export async function consumeOraQuota(
  userId: string,
  tier: string,
  kind: OraQuotaKind,
): Promise<OraQuotaResult> {
  const key = tierKey(tier);
  const isMessage = kind === "message";
  const limit = isMessage ? TIER_ORA_MESSAGE_LIMIT[key] : TIER_ORA_IMAGE_LIMIT[key];
  const windowHours = TIER_ORA_WINDOW_HOURS[key];
  try {
    const t = oraUsageWindowsTable;
    // True when the stored window has already elapsed and should be reset.
    const expired = sql`${t.windowStart} <= now() - (${windowHours} * interval '1 hour')`;
    const counterCol = isMessage ? t.messageCount : t.imageCount;
    const rows = await db
      .insert(t)
      .values({
        userId,
        windowStart: sql`now()`,
        messageCount: isMessage ? 1 : 0,
        imageCount: isMessage ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: t.userId,
        set: {
          windowStart: sql`CASE WHEN ${expired} THEN now() ELSE ${t.windowStart} END`,
          messageCount: isMessage
            ? sql`CASE WHEN ${expired} THEN 1 ELSE ${t.messageCount} + 1 END`
            : sql`CASE WHEN ${expired} THEN 0 ELSE ${t.messageCount} END`,
          imageCount: isMessage
            ? sql`CASE WHEN ${expired} THEN 0 ELSE ${t.imageCount} END`
            : sql`CASE WHEN ${expired} THEN 1 ELSE ${t.imageCount} + 1 END`,
          updatedAt: sql`now()`,
        },
        // Allow the update when the window is expired (reset) OR still has room.
        setWhere: sql`(${expired}) OR (${counterCol} < ${limit})`,
      })
      .returning({
        messageCount: t.messageCount,
        imageCount: t.imageCount,
        windowStart: t.windowStart,
      });
    if (rows.length > 0) {
      const row = rows[0]!;
      const used = isMessage ? row.messageCount : row.imageCount;
      return {
        allowed: true,
        used,
        limit,
        kind,
        resetsAt: resetsAtIso(row.windowStart as Date, windowHours),
      };
    }
    // setWhere excluded the row → already at the limit in an active window. Read
    // the current snapshot so the response can show accurate used/resets values.
    const snap = await getOraUsage(userId, tier);
    return {
      allowed: false,
      used: isMessage ? snap.messageCount : snap.imageCount,
      limit,
      kind,
      resetsAt: snap.resetsAt,
    };
  } catch (err) {
    // Usage table unavailable — fail open rather than blocking Ora, but always
    // log so the on-call team can detect DB degradation before it becomes an
    // outage. Silent fail-open would mask DB connection issues for hours.
    logger.warn(
      { event: "ora_quota_fail_open", userId, tier, kind, err },
      "ora quota DB unavailable — failing open (usage not metered this request)",
    );
    return { allowed: true, used: 0, limit, kind, resetsAt: null };
  }
}

/**
 * Give back one unit previously reserved by consumeOraQuota when the metered
 * action did not complete. Floored at 0 so a refund can never drive the counter
 * negative. Best-effort: never throws into the request path. The refund targets
 * the user's row directly; since it always follows a consume within the same
 * request, the window is still the one that was just charged.
 */
export async function refundOraQuota(userId: string, kind: OraQuotaKind): Promise<void> {
  const isMessage = kind === "message";
  try {
    await db
      .update(oraUsageWindowsTable)
      .set(
        isMessage
          ? {
              messageCount: sql`GREATEST(${oraUsageWindowsTable.messageCount} - 1, 0)`,
              updatedAt: sql`now()`,
            }
          : {
              imageCount: sql`GREATEST(${oraUsageWindowsTable.imageCount} - 1, 0)`,
              updatedAt: sql`now()`,
            },
      )
      .where(eq(oraUsageWindowsTable.userId, userId));
  } catch {
    // Best-effort refund — a missed refund only risks under-counting one unit.
  }
}

/**
 * Message-bucket usage fields for the client. Signed-in users get their current
 * rolling-window message usage + tier limit + reset time; anonymous visitors get
 * the per-session counter. Accepts a structural {userId, tier} so callers can
 * pass an AuthedOraUser.
 */
export async function oraMessageFields(
  authed: { userId: string; tier: string } | null,
  sessionMsgCount: number,
): Promise<{ msgCount: number; msgLimit: number; resetsAt: string | null }> {
  if (!authed) return { msgCount: sessionMsgCount, msgLimit: MSG_LIMIT_VALUE, resetsAt: null };
  const u = await getOraUsage(authed.userId, authed.tier);
  return { msgCount: u.messageCount, msgLimit: u.messageLimit, resetsAt: u.resetsAt };
}
