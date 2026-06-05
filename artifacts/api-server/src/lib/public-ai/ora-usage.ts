/**
 * Ora daily usage metering.
 *
 * Ora is a STANDALONE assistant metered by message-based DAILY quotas per
 * subscription tier — NOT by the AI Builder credit wallet. This module is the
 * single source of truth for reading/incrementing a signed-in user's per-day
 * Ora usage. Anonymous visitors are metered separately by the JWT session cap
 * (see session.ts) and never touch this table.
 *
 * ISOLATION: must NOT import from builder.ts, ai.ts, jobs.ts, or the credits
 * module — keeping Ora fully decoupled from the Builder's billing.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  oraDailyUsageTable,
  TIER_DAILY_MESSAGE_LIMIT,
  TIER_DAILY_IMAGE_LIMIT,
  type SubscriptionTier,
} from "@workspace/db";
import { MSG_LIMIT_VALUE } from "./session";

/** Calendar day in UTC, formatted YYYY-MM-DD. Resets at midnight UTC. */
export function oraUsageDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Coerce an arbitrary tier string to a known tier, defaulting to "free". */
function tierKey(tier: string): SubscriptionTier {
  return tier === "core" || tier === "wave" ? tier : "free";
}

export type OraQuotaKind = "message" | "image";

export interface OraUsageSnapshot {
  date: string;
  messageCount: number;
  imageCount: number;
  messageLimit: number;
  imageLimit: number;
}

export interface OraQuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
  kind: OraQuotaKind;
}

/**
 * Read today's Ora usage for a user, plus the limits for their tier. Returns
 * zeroed counts when the table is unavailable (fail-open on read; enforcement
 * still happens against the tier limit).
 */
export async function getTodayOraUsage(userId: string, tier: string): Promise<OraUsageSnapshot> {
  const date = oraUsageDate();
  const key = tierKey(tier);
  let messageCount = 0;
  let imageCount = 0;
  try {
    const [row] = await db
      .select({
        messageCount: oraDailyUsageTable.messageCount,
        imageCount: oraDailyUsageTable.imageCount,
      })
      .from(oraDailyUsageTable)
      .where(and(eq(oraDailyUsageTable.userId, userId), eq(oraDailyUsageTable.usageDate, date)));
    if (row) {
      messageCount = row.messageCount;
      imageCount = row.imageCount;
    }
  } catch {
    // ora_daily_usage may be unavailable in some envs — treat as zero usage.
  }
  return {
    date,
    messageCount,
    imageCount,
    messageLimit: TIER_DAILY_MESSAGE_LIMIT[key],
    imageLimit: TIER_DAILY_IMAGE_LIMIT[key],
  };
}

/**
 * Check whether the user is still under their daily quota for the given bucket.
 * Does not mutate — call increment* after the action succeeds.
 */
export async function checkOraQuota(
  userId: string,
  tier: string,
  kind: OraQuotaKind,
): Promise<OraQuotaResult> {
  const usage = await getTodayOraUsage(userId, tier);
  const used = kind === "image" ? usage.imageCount : usage.messageCount;
  const limit = kind === "image" ? usage.imageLimit : usage.messageLimit;
  return { allowed: used < limit, used, limit, kind };
}

/** Atomic upsert-increment of one counter for today's row. */
async function incrementColumn(userId: string, kind: OraQuotaKind): Promise<void> {
  const date = oraUsageDate();
  const isMessage = kind === "message";
  await db
    .insert(oraDailyUsageTable)
    .values({
      userId,
      usageDate: date,
      messageCount: isMessage ? 1 : 0,
      imageCount: isMessage ? 0 : 1,
    })
    .onConflictDoUpdate({
      target: [oraDailyUsageTable.userId, oraDailyUsageTable.usageDate],
      set: isMessage
        ? { messageCount: sql`${oraDailyUsageTable.messageCount} + 1`, updatedAt: sql`now()` }
        : { imageCount: sql`${oraDailyUsageTable.imageCount} + 1`, updatedAt: sql`now()` },
    });
}

/** Record one Ora message (answer/deep/search/file-gen/analysis). */
export async function incrementOraMessage(userId: string): Promise<void> {
  await incrementColumn(userId, "message");
}

/** Record one Ora image generation/edit. */
export async function incrementOraImage(userId: string): Promise<void> {
  await incrementColumn(userId, "image");
}

/**
 * Message-bucket usage fields for the client. Signed-in users get today's DAILY
 * message usage + tier limit; anonymous visitors get the per-session counter.
 * Accepts a structural {userId, tier} so callers can pass an AuthedOraUser.
 */
export async function oraMessageFields(
  authed: { userId: string; tier: string } | null,
  sessionMsgCount: number,
): Promise<{ msgCount: number; msgLimit: number }> {
  if (!authed) return { msgCount: sessionMsgCount, msgLimit: MSG_LIMIT_VALUE };
  const u = await getTodayOraUsage(authed.userId, authed.tier);
  return { msgCount: u.messageCount, msgLimit: u.messageLimit };
}
