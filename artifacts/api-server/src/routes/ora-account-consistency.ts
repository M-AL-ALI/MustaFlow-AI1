import { Router } from "express";
import { createHash } from "node:crypto";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import {
  db,
  oraConversationsTable,
  oraProjectsTable,
  knowledgeEntriesTable,
  oraAssetsTable,
  supportTicketsTable,
  userSubscriptionsTable,
} from "@workspace/db";
import type { OraAccountConsistency } from "@workspace/ora-contracts";
import { logger } from "../lib/logger";
import { resolveTierForUser } from "../lib/public-ai/authed-user";
import { getOraUsage } from "../lib/public-ai/ora-usage";
import { isSuperuser } from "../lib/superusers";
import { getClerkUserById } from "../lib/clerk-users";

const router = Router();

/* ─── Ora account-consistency diagnostics ─────────────────────────────────────
 * GET /api/ora/account-consistency
 *
 * Privacy-safe, owner-scoped snapshot used by the website and mobile Settings
 * "account sync" panels to confirm the SAME Clerk user resolves to the same
 * server-side identity, billing tier, chat tier, and per-user counts on BOTH
 * surfaces. Protected by attachUser (the /ora prefix is already in
 * KNOWN_PREFIXES, so signed-out callers get a 401 before reaching here).
 *
 * Hard privacy rules (enforced by tests):
 *  - Never return the raw user id. Identity is exposed only as a stable
 *    sha256 fingerprint (first 12 chars) plus the last 4 chars of the Clerk id.
 *  - Never return message bodies, memory content, asset bytes, asset keys, or
 *    support message text. "latest" rows carry an id + a short label + a
 *    timestamp only.
 *  - Every count and latest-row query is filtered by the caller's own userId.
 */

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function countRows(query: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await query;
  return rows[0]?.c ?? 0;
}

router.get("/ora/account-consistency", async (req, res) => {
  const userId = req.userId!;
  try {
    const userIdHash = createHash("sha256").update(userId).digest("hex").slice(0, 12);
    const clerkUserIdLast4 = userId.length >= 4 ? userId.slice(-4) : null;

    // Effective tier (subscription status + superuser fallback) — the SAME
    // resolver the chat path uses, so billing tier and chat tier always agree
    // for a given user. Raw subscription metadata is read separately for the
    // source tier / status / period display.
    const [effective, superuser, subRows, clerkUser] = await Promise.all([
      resolveTierForUser(userId),
      isSuperuser(userId),
      db
        .select({
          tier: userSubscriptionsTable.tier,
          status: userSubscriptionsTable.status,
          currentPeriodEnd: userSubscriptionsTable.currentPeriodEnd,
          cancelAtPeriodEnd: userSubscriptionsTable.cancelAtPeriodEnd,
        })
        .from(userSubscriptionsTable)
        .where(eq(userSubscriptionsTable.userId, userId))
        .limit(1),
      getClerkUserById(userId),
    ]);

    const sub = subRows[0] ?? null;
    const usage = await getOraUsage(userId, effective.tier);

    // Per-user counts — all owner-scoped, all excluding soft-deleted rows.
    const [
      conversations,
      projects,
      userLevelMemories,
      projectMemories,
      assets,
      supportTickets,
      latestConvRows,
      latestProjectRows,
      latestMemoryRows,
    ] = await Promise.all([
      countRows(
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(oraConversationsTable)
          .where(
            and(
              eq(oraConversationsTable.userId, userId),
              eq(oraConversationsTable.surface, "normal"),
              isNull(oraConversationsTable.archivedAt),
            ),
          ),
      ),
      countRows(
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(oraProjectsTable)
          .where(and(eq(oraProjectsTable.userId, userId), isNull(oraProjectsTable.archivedAt))),
      ),
      countRows(
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(knowledgeEntriesTable)
          .where(
            and(
              eq(knowledgeEntriesTable.userId, userId),
              eq(knowledgeEntriesTable.scope, "user"),
              eq(knowledgeEntriesTable.origin, "ora"),
              isNull(knowledgeEntriesTable.archivedAt),
            ),
          ),
      ),
      countRows(
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(knowledgeEntriesTable)
          .where(
            and(
              eq(knowledgeEntriesTable.userId, userId),
              eq(knowledgeEntriesTable.scope, "project"),
              eq(knowledgeEntriesTable.origin, "ora"),
              sql`${knowledgeEntriesTable.oraProjectId} is not null`,
              isNull(knowledgeEntriesTable.archivedAt),
            ),
          ),
      ),
      countRows(
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(oraAssetsTable)
          .where(and(eq(oraAssetsTable.userId, userId), isNull(oraAssetsTable.deletedAt))),
      ),
      countRows(
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(supportTicketsTable)
          .where(eq(supportTicketsTable.userId, userId)),
      ),
      db
        .select({
          id: oraConversationsTable.id,
          title: oraConversationsTable.title,
          updatedAt: oraConversationsTable.updatedAt,
        })
        .from(oraConversationsTable)
        .where(
          and(
            eq(oraConversationsTable.userId, userId),
            eq(oraConversationsTable.surface, "normal"),
            isNull(oraConversationsTable.archivedAt),
          ),
        )
        .orderBy(desc(oraConversationsTable.updatedAt))
        .limit(1),
      db
        .select({
          id: oraProjectsTable.id,
          name: oraProjectsTable.name,
          updatedAt: oraProjectsTable.updatedAt,
        })
        .from(oraProjectsTable)
        .where(and(eq(oraProjectsTable.userId, userId), isNull(oraProjectsTable.archivedAt)))
        .orderBy(desc(oraProjectsTable.updatedAt))
        .limit(1),
      db
        .select({
          id: knowledgeEntriesTable.id,
          title: knowledgeEntriesTable.title,
          createdAt: knowledgeEntriesTable.createdAt,
        })
        .from(knowledgeEntriesTable)
        .where(
          and(
            eq(knowledgeEntriesTable.userId, userId),
            eq(knowledgeEntriesTable.origin, "ora"),
            isNull(knowledgeEntriesTable.archivedAt),
          ),
        )
        .orderBy(desc(knowledgeEntriesTable.createdAt))
        .limit(1),
    ]);

    const latestConv = latestConvRows[0] ?? null;
    const latestProject = latestProjectRows[0] ?? null;
    const latestMemory = latestMemoryRows[0] ?? null;

    const payload: OraAccountConsistency = {
      identity: {
        userIdHash,
        clerkUserIdLast4,
        email: clerkUser?.email ?? null,
      },
      api: {
        environment: process.env.NODE_ENV ?? "development",
        // Echoed request host only — never used to make a server-side request,
        // so there is no SSRF surface here.
        host: req.get("host") ?? null,
      },
      billing: {
        billingTier: effective.tier,
        sourceTier: sub?.tier ?? "free",
        status: sub?.status ?? null,
        isSuperuser: superuser,
        currentPeriodEnd: isoOrNull(sub?.currentPeriodEnd),
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      },
      chatSession: {
        tier: effective.tier,
        isPaid: effective.isPaid,
        messageLimit: usage.messageLimit,
        imageLimit: usage.imageLimit,
        resetsAt: usage.resetsAt,
      },
      counts: {
        conversations,
        projects,
        userLevelMemories,
        projectMemories,
        assets,
        supportTickets,
      },
      latest: {
        conversation: latestConv
          ? {
              id: latestConv.id,
              label: latestConv.title ?? null,
              at: isoOrNull(latestConv.updatedAt),
            }
          : null,
        project: latestProject
          ? {
              id: latestProject.id,
              label: latestProject.name ?? null,
              at: isoOrNull(latestProject.updatedAt),
            }
          : null,
        memory: latestMemory
          ? {
              id: latestMemory.id,
              label: latestMemory.title ?? null,
              at: isoOrNull(latestMemory.createdAt),
            }
          : null,
      },
      checkedAt: new Date().toISOString(),
    };

    res.json(payload);
  } catch (err) {
    logger.error({ err }, "ora account-consistency diagnostics failed");
    res.status(500).json({ error: "Failed to load account diagnostics" });
  }
});

export default router;
