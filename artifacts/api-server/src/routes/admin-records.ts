import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../lib/adminAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

export const ADMIN_RECORD_KINDS = [
  "projects",
  "published-projects",
  "credit-accounts",
  "transactions",
] as const;
export type AdminRecordKind = (typeof ADMIN_RECORD_KINDS)[number];

const ADMIN_RECORD_KIND_SET = new Set<string>(ADMIN_RECORD_KINDS);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_SEARCH_LENGTH = 120;

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function boundedSearch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

/** Stable pseudonym. No raw Clerk identifier or identifier fragment crosses the route. */
export function maskAdminAccount(userId: string): string {
  return `Account ${createHash("sha256").update(userId).digest("hex").slice(0, 10)}`;
}

type CountedRow = { total_count: number | string };

function totalFrom(rows: CountedRow[]): number {
  return rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
}

router.use("/admin/records", requireAdmin);

router.get("/admin/records/:kind", async (req, res): Promise<void> => {
  const kind = req.params.kind;
  if (!ADMIN_RECORD_KIND_SET.has(kind)) {
    res.status(404).json({
      error: "That Admin record view does not exist.",
      code: "admin_record_kind_not_found",
    });
    return;
  }

  const limit = Math.max(1, boundedInteger(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT));
  const offset = boundedInteger(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
  const search = boundedSearch(req.query.q);
  if (search && search.length > MAX_SEARCH_LENGTH) {
    res.status(400).json({
      error: "Search text must be 120 characters or fewer.",
      code: "admin_record_search_too_long",
    });
    return;
  }

  try {
    if (kind === "projects" || kind === "published-projects") {
      const publishedOnly = kind === "published-projects";
      const searchValue = search ? `%${search}%` : null;
      const result = await db.execute<{
        id: number;
        name: string;
        owner_id: string;
        workspace_id: number;
        status: string;
        kind: string;
        stack: string;
        published_snapshot_id: number | null;
        public_slug: string | null;
        updated_at: Date | string;
        total_count: number | string;
      }>(sql`
        SELECT
          project.id,
          project.name,
          project.owner_id,
          project.workspace_id,
          project.status,
          project.kind,
          project.stack,
          project.published_snapshot_id,
          project.public_slug,
          project.updated_at,
          COUNT(*) OVER()::int AS total_count
        FROM projects AS project
        WHERE project.deleted_at IS NULL
          AND (${publishedOnly} = false OR project.status = 'published')
          AND (
            ${searchValue}::text IS NULL
            OR project.name ILIKE ${searchValue}
            OR project.id::text = ${search}
          )
        ORDER BY project.updated_at DESC, project.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);
      const rows = result.rows;
      res.json({
        kind,
        masking: "account-identities-masked",
        page: {
          limit,
          offset,
          total: totalFrom(rows),
          hasMore: offset + rows.length < totalFrom(rows),
        },
        records: rows.map((row) => ({
          recordType: "project",
          id: Number(row.id),
          name: row.name,
          ownerLabel: maskAdminAccount(row.owner_id),
          workspaceId: Number(row.workspace_id),
          status: row.status,
          kind: row.kind,
          stack: row.stack,
          publishedSnapshotId:
            row.published_snapshot_id == null ? null : Number(row.published_snapshot_id),
          publicSlug: row.public_slug,
          updatedAt: timestamp(row.updated_at),
        })),
      });
      return;
    }

    if (kind === "credit-accounts") {
      const result = await db.execute<{
        credit_id: number;
        user_id: string;
        balance: number;
        updated_at: Date | string;
        project_count: number | string;
        transaction_count: number | string;
        total_count: number | string;
      }>(sql`
        SELECT
          credit.id AS credit_id,
          credit.user_id,
          credit.balance,
          credit.updated_at,
          (SELECT COUNT(*)::int FROM projects AS project
            WHERE project.owner_id = credit.user_id AND project.deleted_at IS NULL) AS project_count,
          (SELECT COUNT(*)::int FROM credit_transactions AS transaction
            WHERE transaction.user_id = credit.user_id) AS transaction_count,
          COUNT(*) OVER()::int AS total_count
        FROM user_credits AS credit
        ORDER BY credit.updated_at DESC, credit.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);
      const rows = result.rows;
      res.json({
        kind,
        masking: "account-identities-masked",
        page: {
          limit,
          offset,
          total: totalFrom(rows),
          hasMore: offset + rows.length < totalFrom(rows),
        },
        records: rows.map((row) => ({
          recordType: "credit-account",
          accountId: Number(row.credit_id),
          accountLabel: maskAdminAccount(row.user_id),
          balance: Number(row.balance),
          projectCount: Number(row.project_count),
          transactionCount: Number(row.transaction_count),
          updatedAt: timestamp(row.updated_at),
        })),
      });
      return;
    }

    const result = await db.execute<{
      id: number;
      credit_id: number | null;
      user_id: string;
      project_id: number | null;
      type: string;
      amount: number;
      description: string | null;
      balance_after: number;
      created_at: Date | string;
      total_count: number | string;
    }>(sql`
      SELECT
        transaction.id,
        credit.id AS credit_id,
        transaction.user_id,
        transaction.project_id,
        transaction.type,
        transaction.amount,
        transaction.description,
        transaction.balance_after,
        transaction.created_at,
        COUNT(*) OVER()::int AS total_count
      FROM credit_transactions AS transaction
      LEFT JOIN user_credits AS credit ON credit.user_id = transaction.user_id
      ORDER BY transaction.created_at DESC, transaction.id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);
    const rows = result.rows;
    res.json({
      kind,
      masking: "account-identities-masked",
      page: {
        limit,
        offset,
        total: totalFrom(rows),
        hasMore: offset + rows.length < totalFrom(rows),
      },
      records: rows.map((row) => ({
        recordType: "transaction",
        id: Number(row.id),
        accountId: row.credit_id == null ? null : Number(row.credit_id),
        accountLabel: maskAdminAccount(row.user_id),
        projectId: row.project_id == null ? null : Number(row.project_id),
        type: row.type,
        amount: Number(row.amount),
        description: row.description,
        balanceAfter: Number(row.balance_after),
        createdAt: timestamp(row.created_at),
      })),
    });
  } catch (error) {
    logger.error({ component: "admin-records", kind, error }, "Admin records query failed");
    res.status(503).json({
      error: "Those Admin records are temporarily unavailable.",
      code: "admin_records_unavailable",
    });
  }
});

export default router;
