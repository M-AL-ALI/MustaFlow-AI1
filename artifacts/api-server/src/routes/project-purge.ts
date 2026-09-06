import { Router, type IRouter, type Request } from "express";
import { getAuth } from "@clerk/express";
import { reverificationError } from "@clerk/shared/authorization-errors";
import { and, eq, sql } from "drizzle-orm";

import type { ProjectPurgeOperation } from "@workspace/db";
import type { ProjectPurgeAdmission } from "../lib/project-purge";
import { logger } from "../lib/logger";

const PROJECT_PURGE_REVERIFICATION_MAX_AGE_MINUTES = 10;
const PROJECT_NAME_MAX_LENGTH = 200;
const OPAQUE_ID_MAX_LENGTH = 200;

export type ProjectPurgeImpact = {
  projectId: number;
  name: string;
  deletedAt: string;
  purgeDueAt: string | null;
  restoreAllowed: boolean;
  retirementState: string;
  purgeState: string | null;
  willDelete: string[];
  willDetach: string[];
  requiresReverification: true;
};

type ProjectPurgeRouteDependencies = {
  readImpact(projectId: number, userId: string): Promise<ProjectPurgeImpact | null>;
  acceptManual(input: {
    projectId: number;
    userId: string;
    projectName: string;
    idempotencyKey: string;
    recentlyReverified: boolean;
  }): Promise<ProjectPurgeAdmission>;
  readOwnedOperation(operationId: string, userId: string): Promise<ProjectPurgeOperation | null>;
  serializeOperation(operation: ProjectPurgeOperation): Promise<Record<string, unknown> | null>;
  readCleanupReadiness(): Promise<boolean>;
  recentlyReverified(req: Request, userId: string): boolean;
};

type ReverificationAuth = {
  userId?: string | null;
  sessionClaims?: Record<string, unknown> | null;
  sessionId?: string | null;
  actor?: unknown;
  factorVerificationAge?: unknown;
};

/**
 * Accept only the directly authenticated owner's verified Clerk session. PAT,
 * test-header, desktop, impersonation, and malformed-token paths fail closed.
 */
export function isRecentClerkFirstFactor(
  auth: ReverificationAuth,
  expectedUserId: string,
): boolean {
  const legacyUserId = auth.sessionClaims?.["userId"];
  const resolvedUserId = typeof legacyUserId === "string" ? legacyUserId : auth.userId;
  if (resolvedUserId !== expectedUserId || !auth.sessionId || auth.actor != null) return false;
  const ages = auth.factorVerificationAge;
  if (!Array.isArray(ages) || ages.length !== 2) return false;
  const firstFactorAge = ages[0];
  return (
    typeof firstFactorAge === "number" &&
    Number.isFinite(firstFactorAge) &&
    firstFactorAge >= 0 &&
    firstFactorAge < PROJECT_PURGE_REVERIFICATION_MAX_AGE_MINUTES
  );
}

function parsePositiveProjectId(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= OPAQUE_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function exactProjectName(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "projectName")) return null;
  const name = record.projectName;
  return typeof name === "string" && name.length > 0 && name.length <= PROJECT_NAME_MAX_LENGTH
    ? name
    : null;
}

type ProjectPurgeAdmissionCode = Extract<ProjectPurgeAdmission, { accepted: false }>["code"];

function admissionHttp(code: ProjectPurgeAdmissionCode): {
  status: number;
  error: string;
} {
  switch (code) {
    case "project_purge_not_found":
      return { status: 404, error: "Project not found" };
    case "project_purge_name_mismatch":
      return { status: 409, error: "The project name does not match. Nothing was deleted." };
    case "project_purge_reverification_required":
      return {
        status: 403,
        error: "Please verify your sign-in again before permanently deleting this project.",
      };
    case "project_purge_retirement_incomplete":
      return {
        status: 409,
        error: "Project cleanup must finish before permanent deletion can begin.",
      };
    case "project_purge_operation_conflict":
      return {
        status: 409,
        error: "Permanent deletion is already in progress for this project.",
      };
    case "project_purge_retry_key_reused":
      return {
        status: 409,
        error: "Confirm the project name again to start a fresh verified retry.",
      };
    case "project_purge_retry_unavailable":
      return {
        status: 409,
        error: "Permanent deletion stopped safely. Contact support before trying again.",
      };
    case "project_purge_attempts_exhausted":
      return {
        status: 409,
        error: "Permanent deletion stopped after its retry limit. Contact support for help.",
      };
    case "project_purge_worker_unavailable":
      return {
        status: 503,
        error: "Permanent deletion is temporarily unavailable. Nothing was deleted.",
      };
    case "project_purge_idempotency_key_invalid":
      return { status: 400, error: "The deletion request could not be verified. Try again." };
    default:
      return {
        status: 409,
        error: "Permanent deletion could not be started. Nothing was deleted.",
      };
  }
}

type ImpactRow = {
  project_id: number;
  project_name: string;
  deleted_at: string;
  purge_due_at: string | null;
  retirement_state: string | null;
  purge_state: string | null;
  has_purchased_domain: boolean;
  has_github_connection: boolean;
};

export function projectPurgeDetachmentCategories(input: {
  hasPurchasedDomain: boolean;
  hasGithubConnection: boolean;
}): string[] {
  const categories: string[] = [];
  if (input.hasPurchasedDomain) {
    categories.push("Any purchased domain registration; the registration remains yours");
  }
  if (input.hasGithubConnection) {
    categories.push("Any external GitHub repository; the repository itself is not deleted");
  }
  return categories;
}

const defaultDependencies: ProjectPurgeRouteDependencies = {
  async readImpact(projectId, userId) {
    const { db } = await import("@workspace/db");
    const result = await db.execute<ImpactRow>(sql`
      SELECT
        project.id AS project_id,
        project.name AS project_name,
        project.deleted_at::text,
        purge.due_at::text AS purge_due_at,
        retirement.state AS retirement_state,
        purge.state AS purge_state,
        EXISTS (
          SELECT 1
          FROM purchased_domains purchased_domain
          WHERE purchased_domain.project_id = project.id
        ) AS has_purchased_domain,
        EXISTS (
          SELECT 1
          FROM project_github_connections github_connection
          WHERE github_connection.project_id = project.id
        ) AS has_github_connection
      FROM projects project
      LEFT JOIN LATERAL (
        SELECT operation.state
        FROM project_retirement_operations operation
        WHERE operation.project_id = project.id
        ORDER BY operation.created_at DESC
        LIMIT 1
      ) retirement ON true
      LEFT JOIN LATERAL (
        SELECT operation.state, operation.due_at
        FROM project_purge_operations operation
        WHERE operation.project_id = project.id
        ORDER BY operation.created_at DESC
        LIMIT 1
      ) purge ON true
      WHERE project.id = ${projectId}
        AND project.owner_id = ${userId}
        AND project.deleted_at IS NOT NULL
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      projectId: row.project_id,
      name: row.project_name,
      deletedAt: row.deleted_at,
      purgeDueAt: row.purge_due_at,
      restoreAllowed: row.purge_state === null || row.purge_state === "scheduled",
      retirementState: row.retirement_state ?? "not_started",
      purgeState: row.purge_state,
      willDelete: [
        "Source files, versions, build history, logs, and project secrets",
        "Project-owned uploads, generated images, and saved runtime copies",
        "Project-owned databases, add-ons, previews, published services, routes, and caches",
        "Invitations, share links, support evidence, and NabuFlow integration credentials",
      ],
      willDetach: projectPurgeDetachmentCategories({
        hasPurchasedDomain: row.has_purchased_domain,
        hasGithubConnection: row.has_github_connection,
      }),
      requiresReverification: true,
    };
  },

  async acceptManual(input) {
    const { acceptManualProjectPurge } = await import("../lib/project-purge");
    return acceptManualProjectPurge(input);
  },

  async readOwnedOperation(operationId, userId) {
    const { db, projectPurgeOperationsTable, projectsTable } = await import("@workspace/db");
    const { hashProjectPurgeRequester } = await import("../lib/project-purge");
    const [operation] = await db
      .select()
      .from(projectPurgeOperationsTable)
      .where(eq(projectPurgeOperationsTable.id, operationId))
      .limit(1);
    if (!operation) return null;
    if (operation.requestedByHash === hashProjectPurgeRequester(userId)) return operation;
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, operation.projectId), eq(projectsTable.ownerId, userId)))
      .limit(1);
    return project ? operation : null;
  },

  async serializeOperation(operation) {
    const { canOwnerReadmitProjectPurge, parseStoredProjectPurgeOperation } =
      await import("../lib/project-purge");
    const parsed = parseStoredProjectPurgeOperation(operation);
    if (!parsed.ok) return null;
    return {
      id: parsed.value.operationId,
      projectId: parsed.value.projectId,
      state: parsed.value.state,
      stage: parsed.value.stage,
      trigger: parsed.value.trigger,
      dueAt: parsed.value.dueAt,
      attemptCount: parsed.value.attemptCount,
      failureCode: parsed.value.failureCode,
      failureRetryable: parsed.value.failureRetryable,
      retryAllowed: canOwnerReadmitProjectPurge(parsed.value),
      nextAttemptAt: operation.nextAttemptAt?.toISOString() ?? null,
      terminalEvidence: parsed.value.terminalEvidence,
    };
  },

  async readCleanupReadiness() {
    try {
      const { tenantRuntimeProvider } = await import("../lib/tenant-runtime");
      const candidate = tenantRuntimeProvider as unknown as {
        probeProductionDatabaseProviderHealth?: () => Promise<unknown>;
      };
      if (typeof candidate.probeProductionDatabaseProviderHealth !== "function") return false;
      await candidate.probeProductionDatabaseProviderHealth();
      return true;
    } catch (error) {
      const candidate =
        typeof error === "object" && error !== null
          ? (error as { code?: unknown; status?: unknown; transportCause?: unknown })
          : {};
      logger.warn(
        {
          event: "project_purge_cleanup_readiness_failed",
          code:
            typeof candidate.code === "string" && /^[a-z0-9_]{1,120}$/u.test(candidate.code)
              ? candidate.code
              : "unknown",
          status:
            Number.isSafeInteger(candidate.status) && Number(candidate.status) >= 100
              ? Number(candidate.status)
              : null,
          transportCause:
            typeof candidate.transportCause === "string" &&
            /^[a-z0-9_]{1,80}$/u.test(candidate.transportCause)
              ? candidate.transportCause
              : null,
        },
        "Permanent deletion cleanup readiness check failed",
      );
      return false;
    }
  },

  recentlyReverified(req, userId) {
    try {
      return isRecentClerkFirstFactor(getAuth(req), userId);
    } catch {
      return false;
    }
  },
};

export function createProjectPurgeRouter(
  dependencies: ProjectPurgeRouteDependencies = defaultDependencies,
): IRouter {
  const router = Router();

  router.get("/projects/:id/permanent-deletion-impact", async (req, res): Promise<void> => {
    const projectId = parsePositiveProjectId(req.params.id);
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (projectId === null) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const impact = await dependencies.readImpact(projectId, userId);
    if (!impact) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!impact.purgeDueAt) {
      res.status(503).json({
        code: "project_purge_schedule_pending",
        error: "The deletion schedule is still being prepared. Nothing was deleted.",
      });
      return;
    }
    if (!(await dependencies.readCleanupReadiness())) {
      res.status(503).json({
        code: "project_purge_provider_unavailable",
        error:
          "Permanent deletion database cleanup is temporarily unavailable. Sign-in verification has not started and nothing was deleted.",
        retryable: true,
      });
      return;
    }
    res.json({ ...impact, cleanupReady: true });
  });

  router.delete("/projects/:id/permanent", async (req, res): Promise<void> => {
    const projectId = parsePositiveProjectId(req.params.id);
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (projectId === null) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const projectName = exactProjectName(req.body);
    if (!projectName) {
      res.status(400).json({
        code: "project_purge_name_required",
        error: "Enter the project name exactly before deleting it permanently.",
      });
      return;
    }
    const impact = await dependencies.readImpact(projectId, userId);
    if (!impact) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (impact.name !== projectName) {
      res.status(409).json({
        code: "project_purge_name_mismatch",
        error: "The project name does not match. Nothing was deleted.",
      });
      return;
    }
    if (impact.retirementState !== "completed") {
      res.status(409).json({
        code: "project_purge_retirement_incomplete",
        error: "Project cleanup must finish before permanent deletion can begin.",
      });
      return;
    }
    if (!(await dependencies.readCleanupReadiness())) {
      res.status(503).json({
        code: "project_purge_provider_unavailable",
        error:
          "Permanent deletion database cleanup is temporarily unavailable. Sign-in verification has not started and nothing was deleted.",
        retryable: true,
      });
      return;
    }
    const idempotencyKey = req.get("Idempotency-Key") ?? "";
    if (!dependencies.recentlyReverified(req, userId)) {
      res.status(403).json(
        reverificationError({
          level: "first_factor",
          afterMinutes: PROJECT_PURGE_REVERIFICATION_MAX_AGE_MINUTES,
        }),
      );
      return;
    }
    const admission = await dependencies.acceptManual({
      projectId,
      userId,
      projectName,
      idempotencyKey,
      recentlyReverified: true,
    });
    if (!admission.accepted) {
      const refusal = admissionHttp(admission.code);
      res.status(refusal.status).json({ code: admission.code, error: refusal.error });
      return;
    }
    res.status(202).json({
      code: "project_purge_accepted",
      operationId: admission.operation.id,
      // This is the admission response contract, not a snapshot of worker
      // progress. Idempotent replays keep the same shape; statusUrl carries the
      // operation's current durable truth.
      state: "accepted",
      statusUrl: `/api/project-purge-operations/${admission.operation.id}`,
    });
  });

  router.get("/project-purge-operations/:operationId", async (req, res): Promise<void> => {
    const userId = req.userId;
    const operationId = req.params.operationId;
    if (!userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (!validOpaqueId(operationId)) {
      res.status(404).json({ error: "Deletion request not found" });
      return;
    }
    const operation = await dependencies.readOwnedOperation(operationId, userId);
    if (!operation) {
      res.status(404).json({ error: "Deletion request not found" });
      return;
    }
    const serialized = await dependencies.serializeOperation(operation);
    if (!serialized) {
      res.status(503).json({
        code: "project_purge_receipt_unavailable",
        error: "Deletion progress cannot be verified right now. Try again shortly.",
      });
      return;
    }
    res.json(serialized);
  });

  return router;
}

const router = createProjectPurgeRouter();
export default router;
