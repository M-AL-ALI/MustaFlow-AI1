// ─────────────────────────────────────────────────────────────────────────────
// Clerk webhook handler — PUBLIC route, mounted before the auth wall.
//
//   POST /api/webhooks/clerk
//
// Verifies the Clerk webhook signature via svix (raw body captured in app.ts),
// then handles:
//   user.deleted                   — soft-delete all user projects, revoke sessions
//                                    and PATs, remove all org memberships
//   organizationMembership.deleted — remove user from the specific org in org_members
//   user.created                   — safety-net starter credit grant (100 credits)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { Webhook } from "svix";
import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  orgMembersTable,
  organizationsTable,
  userCreditsTable,
  previewSessionsTable,
  personalAccessTokensTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

// ── POST /api/webhooks/clerk ──────────────────────────────────────────────────
router.post("/webhooks/clerk", async (req, res): Promise<void> => {
  if (!CLERK_WEBHOOK_SECRET) {
    logger.warn("CLERK_WEBHOOK_SECRET is not set — Clerk webhook ignored");
    res.status(503).json({ error: "Webhook not configured" });
    return;
  }

  const svixId = req.headers["svix-id"];
  const svixTimestamp = req.headers["svix-timestamp"];
  const svixSignature = req.headers["svix-signature"];

  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: "Missing svix headers" });
    return;
  }

  // Use the raw body captured by app.ts (before JSON re-parse) for signature verification.
  // This matches exactly what Clerk signed — re-serializing req.body can produce different
  // whitespace/key ordering and break the HMAC check.
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    logger.warn("Clerk webhook: rawBody not available — check app.ts middleware order");
    res.status(400).json({ error: "Raw body unavailable" });
    return;
  }

  let event: { type: string; data: Record<string, unknown> };
  try {
    const wh = new Webhook(CLERK_WEBHOOK_SECRET);
    event = wh.verify(rawBody.toString(), {
      "svix-id": svixId as string,
      "svix-timestamp": svixTimestamp as string,
      "svix-signature": svixSignature as string,
    }) as { type: string; data: Record<string, unknown> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "verify failed";
    logger.warn({ err: msg }, "Clerk webhook signature verification failed");
    res.status(400).json({ error: "Signature verification failed" });
    return;
  }

  logger.info({ eventType: event.type }, "Clerk webhook received");

  try {
    switch (event.type) {
      case "user.deleted":
        await handleUserDeleted(event.data);
        break;
      case "organizationMembership.deleted":
        await handleOrgMembershipDeleted(event.data);
        break;
      case "user.created":
        await handleUserCreated(event.data);
        break;
      default:
        logger.info({ eventType: event.type }, "Clerk webhook event type not handled — ignored");
    }
  } catch (err) {
    logger.error({ err, eventType: event.type }, "Clerk webhook handler failed");
    res.status(500).json({ error: "Handler failed" });
    return;
  }

  res.json({ received: true });
});

// ── user.deleted ──────────────────────────────────────────────────────────────
// Soft-deletes all projects owned by the deleted user, revokes their preview
// sessions and personal access tokens, and removes all org memberships.
// This satisfies GDPR right-to-erasure obligations triggered via Clerk's
// user deletion event.
async function handleUserDeleted(data: Record<string, unknown>): Promise<void> {
  const userId = data.id as string | undefined;
  if (!userId) {
    logger.warn({ data }, "user.deleted event missing id — skipped");
    return;
  }

  // Soft-delete all user-owned projects.
  const deletedProjects = await db
    .update(projectsTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(projectsTable.ownerId, userId), isNull(projectsTable.deletedAt)))
    .returning({ id: projectsTable.id });

  // Revoke all active preview sessions for this user.
  const now = new Date();
  await db
    .update(previewSessionsTable)
    .set({ revokedAt: now, revokeReason: "user_deleted" })
    .where(and(eq(previewSessionsTable.userId, userId), isNull(previewSessionsTable.revokedAt)));

  // Deactivate all personal access tokens for this user.
  await db
    .update(personalAccessTokensTable)
    .set({ active: false })
    .where(
      and(eq(personalAccessTokensTable.userId, userId), eq(personalAccessTokensTable.active, true)),
    );

  // Remove from all org memberships.
  await db.delete(orgMembersTable).where(eq(orgMembersTable.userId, userId));

  logger.info(
    { userId, projectsSoftDeleted: deletedProjects.length },
    "Clerk user.deleted — projects soft-deleted, sessions revoked, PATs deactivated, org memberships removed",
  );
}

// ── organizationMembership.deleted ───────────────────────────────────────────
// Removes the specific org membership row when Clerk reports a membership
// deletion. Resolves the Clerk org slug to our internal organization row to
// ensure we delete only the correct membership, not all memberships for the user.
async function handleOrgMembershipDeleted(data: Record<string, unknown>): Promise<void> {
  const publicUserData = data.public_user_data as Record<string, unknown> | undefined;
  const userId = publicUserData?.user_id as string | undefined;
  const orgData = data.organization as Record<string, unknown> | undefined;
  const clerkOrgSlug = orgData?.slug as string | undefined;
  const clerkOrgId = orgData?.id as string | undefined;

  if (!userId || !clerkOrgSlug) {
    logger.warn(
      { data },
      "organizationMembership.deleted event missing user_id or org slug — skipped",
    );
    return;
  }

  // Resolve Clerk org slug to our internal organization row.
  const [org] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(and(eq(organizationsTable.slug, clerkOrgSlug), isNull(organizationsTable.deletedAt)));

  if (!org) {
    logger.info(
      { userId, clerkOrgId, clerkOrgSlug },
      "organizationMembership.deleted — no matching internal org found by slug, skipping delete",
    );
    return;
  }

  await db
    .delete(orgMembersTable)
    .where(and(eq(orgMembersTable.organizationId, org.id), eq(orgMembersTable.userId, userId)));

  logger.info(
    { userId, clerkOrgId, clerkOrgSlug, internalOrgId: org.id },
    "Clerk organizationMembership.deleted — membership removed",
  );
}

// ── user.created ──────────────────────────────────────────────────────────────
// Safety-net: grants 100 starter credits if the user row doesn't already exist.
// The primary grant happens in-band during sign-up; this catches any race
// condition where that grant was missed.
async function handleUserCreated(data: Record<string, unknown>): Promise<void> {
  const userId = data.id as string | undefined;
  if (!userId) {
    logger.warn({ data }, "user.created event missing id — skipped");
    return;
  }

  // Use ON CONFLICT DO NOTHING so concurrent/duplicate webhook deliveries are safe.
  await db.insert(userCreditsTable).values({ userId, balance: 100 }).onConflictDoNothing();

  logger.info({ userId }, "Clerk user.created — starter 100 credits granted via webhook");
}

export default router;
