import { eq, sql } from "drizzle-orm";
import {
  communityProfilesTable,
  db,
  oraProfilesTable,
  sharedProfileMigrationReceiptsTable,
} from "@workspace/db";
import {
  getSharedAccountProfile,
  updateSharedAccountProfile,
  type SharedAccountProfile,
} from "./clerk-users";

export type SharedProfileMigrationCandidate = {
  userId: string;
  oraPreferredName: string | null;
  oraPreferredLanguage: string | null;
  communityDisplayName: string | null;
  communityAvatarUrl: string | null;
};

export type SharedProfileMigrationDecision =
  | {
      kind: "ready";
      displayName: string;
      preferredLanguage: string | null;
      shouldUpdateAccount: boolean;
    }
  | {
      kind: "blocked";
      reason: "account_unavailable" | "display_name_missing" | "picture_needs_owner";
    };

type BlockedReason = Extract<SharedProfileMigrationDecision, { kind: "blocked" }>["reason"];

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Choose only identity data the account already holds. Community biography and
 * links remain public-community data; Ora coaching preferences remain settings.
 */
export function decideSharedProfileMigration(
  candidate: SharedProfileMigrationCandidate,
  account: SharedAccountProfile | null,
): SharedProfileMigrationDecision {
  if (!account) return { kind: "blocked", reason: "account_unavailable" };
  if (!clean(account.imageUrl) && clean(candidate.communityAvatarUrl)) {
    return { kind: "blocked", reason: "picture_needs_owner" };
  }
  const displayName =
    clean(account.displayName) ??
    clean(candidate.oraPreferredName) ??
    clean(candidate.communityDisplayName);
  if (!displayName) return { kind: "blocked", reason: "display_name_missing" };
  const preferredLanguage =
    clean(account.preferredLanguage) ?? clean(candidate.oraPreferredLanguage);
  return {
    kind: "ready",
    displayName,
    preferredLanguage,
    shouldUpdateAccount:
      displayName !== clean(account.displayName) ||
      preferredLanguage !== clean(account.preferredLanguage),
  };
}

type CandidateRow = {
  user_id: string;
  ora_preferred_name: string | null;
  ora_preferred_language: string | null;
  community_display_name: string | null;
  community_avatar_url: string | null;
};

async function readCandidates(limit: number): Promise<SharedProfileMigrationCandidate[]> {
  const result = await db.execute<CandidateRow>(sql`
    WITH identities AS (
      SELECT user_id FROM ora_profiles
      UNION
      SELECT user_id FROM community_profiles
    )
    SELECT
      identities.user_id,
      ora.preferred_name AS ora_preferred_name,
      ora.preferred_language AS ora_preferred_language,
      community.display_name AS community_display_name,
      community.avatar_url AS community_avatar_url
    FROM identities
    LEFT JOIN ora_profiles ora ON ora.user_id = identities.user_id
    LEFT JOIN community_profiles community ON community.user_id = identities.user_id
    LEFT JOIN shared_profile_migration_receipts receipt ON receipt.user_id = identities.user_id
    WHERE receipt.id IS NULL
      AND (
        ora.preferred_name IS NOT NULL OR
        ora.preferred_language IS NOT NULL OR
        community.display_name IS NOT NULL OR
        community.avatar_url IS NOT NULL
      )
    ORDER BY identities.user_id
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    userId: row.user_id,
    oraPreferredName: row.ora_preferred_name,
    oraPreferredLanguage: row.ora_preferred_language,
    communityDisplayName: row.community_display_name,
    communityAvatarUrl: row.community_avatar_url,
  }));
}

async function countCandidates(): Promise<number> {
  const result = await db.execute<{ count: number | string }>(sql`
    WITH identities AS (
      SELECT user_id FROM ora_profiles
      UNION
      SELECT user_id FROM community_profiles
    )
    SELECT count(*)::int AS count
    FROM identities
    LEFT JOIN ora_profiles ora ON ora.user_id = identities.user_id
    LEFT JOIN community_profiles community ON community.user_id = identities.user_id
    LEFT JOIN shared_profile_migration_receipts receipt ON receipt.user_id = identities.user_id
    WHERE receipt.id IS NULL
      AND (
        ora.preferred_name IS NOT NULL OR
        ora.preferred_language IS NOT NULL OR
        community.display_name IS NOT NULL OR
        community.avatar_url IS NOT NULL
      )
  `);
  return Number(result.rows[0]?.count ?? 0);
}

export type SharedProfileMigrationResult = {
  inspected: number;
  migrated: number;
  noChange: number;
  blocked: Array<{ userId: string; reason: BlockedReason }>;
  remaining: number;
};

export async function migrateSharedProfiles(input: {
  mode: "dry-run" | "apply";
  limit: number;
}): Promise<SharedProfileMigrationResult> {
  const candidates = await readCandidates(input.limit);
  const result: SharedProfileMigrationResult = {
    inspected: candidates.length,
    migrated: 0,
    noChange: 0,
    blocked: [],
    remaining: 0,
  };

  for (const candidate of candidates) {
    const account = await getSharedAccountProfile(candidate.userId);
    const decision = decideSharedProfileMigration(candidate, account);
    if (decision.kind === "blocked") {
      result.blocked.push({ userId: candidate.userId, reason: decision.reason });
      continue;
    }
    if (input.mode === "dry-run") {
      if (decision.shouldUpdateAccount) result.migrated++;
      else result.noChange++;
      continue;
    }
    if (decision.shouldUpdateAccount) {
      await updateSharedAccountProfile(candidate.userId, {
        displayName: decision.displayName,
        preferredLanguage: decision.preferredLanguage,
      });
      result.migrated++;
    } else {
      result.noChange++;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(oraProfilesTable)
        .set({ preferredName: null, preferredLanguage: null, updatedAt: new Date() })
        .where(eq(oraProfilesTable.userId, candidate.userId));
      await tx
        .update(communityProfilesTable)
        .set({ displayName: null, avatarUrl: null, updatedAt: new Date() })
        .where(eq(communityProfilesTable.userId, candidate.userId));
      await tx
        .insert(sharedProfileMigrationReceiptsTable)
        .values({
          userId: candidate.userId,
          source: "ora_profiles+community_profiles",
          outcome: decision.shouldUpdateAccount ? "migrated" : "canonical_already",
        })
        .onConflictDoNothing();
    });
  }

  result.remaining = await countCandidates();
  return result;
}
