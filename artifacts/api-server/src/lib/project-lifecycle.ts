import { and, eq, isNull } from "drizzle-orm";
import { db, pool, projectsTable } from "@workspace/db";
import type { NextFunction, Request, Response } from "express";
import { checkProjectAccess } from "./auth";
import { PROJECT_LIFECYCLE_LOCK_NAMESPACE } from "./project-retirement-contract";
import { findLiveSupportGrant } from "./support-access";

const PROJECT_LIFECYCLE_LOCK_WAIT_MS = 15_000;
const PROJECT_LIFECYCLE_LOCK_POLL_MS = 25;

export type ProjectLifecycleAdmission =
  | { allowed: true; projectId: number }
  | { allowed: false; projectId: number; code: "project_inactive" };

export interface ActiveProjectLifecycleSession {
  readonly projectId: number;
  assertActive(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * Metadata-only project admission check. This never acquires a lock and never writes.
 * Mutation callers that cross a provider boundary must use acquireProjectLifecycleSession().
 */
export async function readProjectLifecycleAdmission(
  projectId: number,
): Promise<ProjectLifecycleAdmission> {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)))
    .limit(1);
  return project?.id === projectId
    ? { allowed: true, projectId }
    : { allowed: false, projectId, code: "project_inactive" };
}

/**
 * Hold the same two-key advisory lock used by governed Trash on one dedicated
 * connection. The lock spans provider mutation and the final database receipt,
 * so Trash either wins before the operation starts or runs after it and cleans
 * the completed resources. There is no window for work to recreate resources
 * after a committed tombstone.
 */
export async function acquireProjectLifecycleSession(
  projectId: number,
): Promise<ActiveProjectLifecycleSession | null> {
  if (!Number.isSafeInteger(projectId) || projectId < 1) return null;
  const client = await pool.connect();
  let locked = false;
  let released = false;

  try {
    const deadline = Date.now() + PROJECT_LIFECYCLE_LOCK_WAIT_MS;
    while (!locked && Date.now() < deadline) {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
        [PROJECT_LIFECYCLE_LOCK_NAMESPACE, projectId],
      );
      locked = result.rows[0]?.acquired === true;
      if (!locked) {
        await new Promise<void>((resolve) => setTimeout(resolve, PROJECT_LIFECYCLE_LOCK_POLL_MS));
      }
    }
    if (!locked) {
      client.release();
      return null;
    }

    const assertActive = async (): Promise<boolean> => {
      const result = await client.query<{ id: number }>(
        "SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
        [projectId],
      );
      return result.rows[0]?.id === projectId;
    };

    if (!(await assertActive())) {
      await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
        PROJECT_LIFECYCLE_LOCK_NAMESPACE,
        projectId,
      ]);
      locked = false;
      client.release();
      return null;
    }

    return {
      projectId,
      assertActive,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try {
          if (locked) {
            await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
              PROJECT_LIFECYCLE_LOCK_NAMESPACE,
              projectId,
            ]);
            locked = false;
          }
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
          PROJECT_LIFECYCLE_LOCK_NAMESPACE,
          projectId,
        ]);
      }
    } finally {
      client.release();
    }
    throw error;
  }
}

/** Execute one mutation while holding the project lifecycle session. */
export async function withActiveProjectLifecycle<T>(
  projectId: number,
  work: (session: ActiveProjectLifecycleSession) => Promise<T>,
): Promise<{ state: "active"; value: T } | { state: "inactive" }> {
  const session = await acquireProjectLifecycleSession(projectId);
  if (!session) return { state: "inactive" };
  try {
    return { state: "active", value: await work(session) };
  } finally {
    await session.release();
  }
}

const projectWorkControllers = new Map<number, Set<AbortController>>();

/** Bind non-agent work (answering/provisioning/provider jobs) to Trash cancellation. */
export function registerProjectWorkController(
  projectId: number,
  controller: AbortController,
): () => void {
  const controllers = projectWorkControllers.get(projectId) ?? new Set<AbortController>();
  controllers.add(controller);
  projectWorkControllers.set(projectId, controllers);
  return () => {
    const current = projectWorkControllers.get(projectId);
    current?.delete(controller);
    if (current?.size === 0) projectWorkControllers.delete(projectId);
  };
}

export function abortLocalProjectWork(projectId: number): number {
  const controllers = projectWorkControllers.get(projectId);
  if (!controllers) return 0;
  const count = controllers.size;
  for (const controller of controllers) controller.abort();
  projectWorkControllers.delete(projectId);
  return count;
}

const LIFECYCLE_SESSION_LOCAL = "projectLifecycleSession";
const LIFECYCLE_SESSION_STATE_LOCAL = "projectLifecycleSessionState";

type ResponseProjectLifecycleState = {
  session: ActiveProjectLifecycleSession;
  responseEnded: boolean;
  holds: number;
  releaseStarted: boolean;
};

async function maybeReleaseResponseProjectLifecycleSession(
  state: ResponseProjectLifecycleState,
): Promise<void> {
  if (!state.responseEnded || state.holds > 0 || state.releaseStarted) return;
  state.releaseStarted = true;
  await state.session.release();
}

const PROJECT_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resolve the project governed by an authenticated HTTP mutation. Trash,
 * restore, and governed retirement reconciliation are lifecycle transitions
 * themselves, so they deliberately sit outside the active-project admission
 * boundary. Each transition performs its own ownership check and acquires the
 * same lifecycle advisory lock while it changes state.
 */
export function projectMutationLifecycleProjectId(input: {
  method: string;
  path: string;
}): number | null {
  const method = input.method.toUpperCase();
  if (!PROJECT_MUTATION_METHODS.has(method)) return null;
  const normalizedPath = input.path.replace(/\/+$/u, "") || "/";
  const match = /^\/projects\/(\d+)(?:\/|$)/iu.exec(normalizedPath);
  if (!match) return null;
  const projectId = Number(match[1]);
  if (!Number.isSafeInteger(projectId) || projectId < 1) return null;
  const requestProjectRoot = `/projects/${match[1]}`;
  if (method === "DELETE" && normalizedPath.toLowerCase() === requestProjectRoot) return null;
  if (method === "POST") {
    const lifecyclePath = normalizedPath.toLowerCase();
    if (
      lifecyclePath === `${requestProjectRoot}/restore` ||
      lifecyclePath === `${requestProjectRoot}/retirement/retry`
    ) {
      return null;
    }
  }
  return projectId;
}

async function admitResponseProjectLifecycleSession(
  projectId: number,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const existing = (res.locals as Record<string, unknown>)[LIFECYCLE_SESSION_LOCAL] as
    | ActiveProjectLifecycleSession
    | undefined;
  if (existing) {
    if (existing.projectId !== projectId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
    return;
  }

  const session = await acquireProjectLifecycleSession(projectId);
  if (!session) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  (res.locals as Record<string, unknown>)[LIFECYCLE_SESSION_LOCAL] = session;
  const state: ResponseProjectLifecycleState = {
    session,
    responseEnded: false,
    holds: 0,
    releaseStarted: false,
  };
  (res.locals as Record<string, unknown>)[LIFECYCLE_SESSION_STATE_LOCAL] = state;
  const markResponseEnded = (): void => {
    state.responseEnded = true;
    void maybeReleaseResponseProjectLifecycleSession(state).catch(() => undefined);
  };
  res.once("finish", markResponseEnded);
  res.once("close", markResponseEnded);
  next();
}

/**
 * Authenticated router-wide boundary for ordinary project mutations.  This is
 * intentionally mounted once before the project routers so a new path cannot
 * silently bypass the Trash race fence.
 */
export async function requireActiveProjectMutationLifecycleSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const projectId = projectMutationLifecycleProjectId({ method: req.method, path: req.path });
  if (projectId === null) {
    next();
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const access = await checkProjectAccess(userId, projectId, "viewer");
  if (access !== "granted") {
    // A missing/tombstoned project cannot have an active lifecycle admission,
    // even if an old support grant row has not yet been closed.
    const supportGrant =
      access === "not_found"
        ? null
        : await findLiveSupportGrant({ projectId, staffUserId: userId });
    if (!supportGrant) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
  }

  await admitResponseProjectLifecycleSession(projectId, res, next);
}

/** Project id derived from a signed state, body, or resource lookup. */
export async function requireActiveProjectLifecycleFor(
  projectId: number,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await admitResponseProjectLifecycleSession(projectId, res, next);
}

/** Express boundary for project mutations that must span provider calls. */
export async function requireActiveProjectLifecycleSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const projectId = Number(req.params.id);
  await admitResponseProjectLifecycleSession(projectId, res, next);
}

export function responseProjectLifecycleSession(res: Response): ActiveProjectLifecycleSession {
  const session = (res.locals as Record<string, unknown>)[LIFECYCLE_SESSION_LOCAL];
  if (!session) throw new Error("project_lifecycle_session_missing");
  return session as ActiveProjectLifecycleSession;
}

/**
 * Keep the admitted lifecycle lock after the HTTP socket closes while a
 * provider mutation and its compensating cleanup settle.  This prevents a
 * disconnected upload from completing after Trash has observed the request as
 * gone.  The returned release is idempotent and must run from a finally block.
 */
export function holdResponseProjectLifecycleSession(res: Response): () => Promise<void> {
  const state = (res.locals as Record<string, unknown>)[LIFECYCLE_SESSION_STATE_LOCAL] as
    | ResponseProjectLifecycleState
    | undefined;
  if (!state || state.releaseStarted) throw new Error("project_lifecycle_session_missing");
  state.holds += 1;
  let released = false;
  return async (): Promise<void> => {
    if (released) return;
    released = true;
    state.holds = Math.max(0, state.holds - 1);
    await maybeReleaseResponseProjectLifecycleSession(state);
  };
}
