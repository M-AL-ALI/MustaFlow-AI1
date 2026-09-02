/**
 * GDPR erasure worker — hard-deletes all data for a user 30 days after their
 * deletion request. Registered as a pg-boss durable job (mustaflow.gdpr-erasure).
 *
 * Idempotent: safe to retry — all deletes use WHERE clauses that are no-ops
 * when the rows are already gone.
 *
 * Project rows and provider resources are deliberately NOT deleted here.
 * They must already have reached terminal deletion through the governed
 * project-purge coordinator before account-level erasure can continue.
 *
 * What gets deleted after that boundary:
 *  - Knowledge vault entries owned by the user
 *  - Org membership rows
 *  - Credit balance and transaction history
 *  - User subscription record
 *  - User preferences (including erasure job metadata)
 *  - Personal access tokens
 *
 * External storage and recurring billing are never mutated by this worker.
 * Any remaining project, asset, or live paid receipt makes the job retry.
 */

import {
  db,
  projectsTable,
  knowledgeEntriesTable,
  orgMembersTable,
  userCreditsTable,
  creditTransactionsTable,
  userPreferencesTable,
  userSubscriptionsTable,
  personalAccessTokensTable,
  oraTranscriptsTable,
  assetsTable,
  accountAssetQuotaTable,
  storageAddonSubscriptionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { evictTierCache } from "./public-ai/authed-user";

/**
 * Hard-erase all platform data for a given userId.
 * Called by the durable GDPR erasure job ~30 days after account deletion is initiated.
 */
export async function runGdprErasure(userId: string): Promise<void> {
  logger.info({ userId }, "gdpr-erasure: starting hard-delete for user");

  // Project deletion has its own durable coordinator, provider absence proofs,
  // and retry receipts. Bypassing it here used to destroy ownership evidence
  // while provider resources could still be live. Refuse until that coordinator
  // has removed every owned project row.
  const userProjects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.ownerId, userId));
  if (userProjects.length > 0) throw new Error("gdpr_owned_projects_remain");

  // Account/thread assets also own provider bytes but are outside any project
  // purge receipt. Keep their ownership evidence and retry instead of deleting
  // R2 objects or metadata from this account-only worker.
  const remainingAssets = await db
    .select({ id: assetsTable.id })
    .from(assetsTable)
    .where(eq(assetsTable.ownerUserId, userId))
    .limit(1);
  if (remainingAssets.length > 0) throw new Error("gdpr_account_assets_remain");

  // A recurring charge must be cancelled through the governed billing surface.
  // Removing its database receipt here would leave the provider obligation
  // invisible, so any non-terminal receipt makes the durable job retry.
  const [storageSubscriptions, accountSubscriptions] = await Promise.all([
    db
      .select({ status: storageAddonSubscriptionsTable.status })
      .from(storageAddonSubscriptionsTable)
      .where(eq(storageAddonSubscriptionsTable.userId, userId)),
    db
      .select({
        tier: userSubscriptionsTable.tier,
        status: userSubscriptionsTable.status,
        stripeSubscriptionId: userSubscriptionsTable.stripeSubscriptionId,
      })
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, userId)),
  ]);
  if (
    storageSubscriptions.some(
      (subscription) => !["canceled", "incomplete_expired"].includes(subscription.status),
    ) ||
    accountSubscriptions.some(
      (subscription) =>
        subscription.tier !== "free" &&
        Boolean(subscription.stripeSubscriptionId) &&
        !["canceled", "incomplete_expired"].includes(subscription.status),
    )
  ) {
    throw new Error("gdpr_active_billing_remains");
  }

  await db
    .delete(storageAddonSubscriptionsTable)
    .where(eq(storageAddonSubscriptionsTable.userId, userId));
  await db.delete(accountAssetQuotaTable).where(eq(accountAssetQuotaTable.userId, userId));

  // ── Hard-delete account-scoped data ───────────────────────────────────────
  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.userId, userId));

  // ── 6. Hard-delete org membership rows ────────────────────────────────────
  await db.delete(orgMembersTable).where(eq(orgMembersTable.userId, userId));

  // ── 7. Hard-delete credits and transactions ───────────────────────────────
  await db.delete(creditTransactionsTable).where(eq(creditTransactionsTable.userId, userId));
  await db.delete(userCreditsTable).where(eq(userCreditsTable.userId, userId));

  // ── 8. Hard-delete subscription record ───────────────────────────────────
  await db.delete(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId));
  evictTierCache(userId);

  // ── 9. Hard-delete personal access tokens ────────────────────────────────
  await db.delete(personalAccessTokensTable).where(eq(personalAccessTokensTable.userId, userId));

  // ── 10. Hard-delete Ora transcript ───────────────────────────────────────
  await db.delete(oraTranscriptsTable).where(eq(oraTranscriptsTable.userId, userId));
  logger.info({ userId }, "gdpr-erasure: ora transcript hard-deleted");

  // ── 11. Hard-delete user preferences (last — contains erasure metadata) ──
  await db.delete(userPreferencesTable).where(eq(userPreferencesTable.userId, userId));

  logger.info({ userId }, "gdpr-erasure: hard-delete complete");
}
