/**
 * Preview Environment routes — test-then-publish workflow.
 *
 * Routes:
 *   POST /api/projects/:id/preview-env/start    Create immutable candidate snapshot + start test container
 *   POST /api/projects/:id/preview-env/rebuild  Re-create candidate from current files (stops old container first)
 *   POST /api/projects/:id/preview-env/stop     Stop the test container
 *   GET  /api/projects/:id/preview-env/status   Return current testing state
 *   POST /api/projects/:id/preview-env/approve  Mark candidate as tested (6 preconditions enforced)
 *   GET  /api/projects/:id/preview-env/session  Return (or create) the active preview session launch URL
 */

import { Router } from "express";
import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectVersionsTable,
  projectFilesTable,
  previewSessionsTable,
  secretsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { getUnresolvedCriticalFindings } from "./readiness";
import {
  createContainer,
  destroyContainer,
  syncFilesToContainer,
  execInContainer,
  getContainerStatus,
} from "../lib/container";
import { encryptionService } from "../lib/encryption";
import { logger } from "../lib/logger";
import { createHash, randomBytes } from "crypto";
import { healthCheckPathForStack, waitForContainerHealthy } from "../lib/health-inject";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours
const LAUNCH_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

const router = Router();

/** Determine whether a project requires a test container (full-stack). */
function isFullStack(project: {
  containerId: string | null;
  stack: string;
  builderMode: string;
}): boolean {
  return !!project.containerId || project.builderMode === "agentic";
}

/** Generate a cryptographically random session ID (16 hex chars). */
function generateSessionId(): string {
  return randomBytes(8).toString("hex");
}

/** Generate a one-time launch token (32 hex chars = 128 bits). */
function generateLaunchToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hash a launch token for DB storage. */
function hashLaunchToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── GET /projects/:id/preview-env/status ─────────────────────────────────────
router.get("/projects/:id/preview-env/status", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);
  const [project] = await db
    .select({
      testingStatus: projectsTable.testingStatus,
      testContainerStatus: projectsTable.testContainerStatus,
      testContainerUrl: projectsTable.testContainerUrl,
      testingCandidateSnapshotId: projectsTable.testingCandidateSnapshotId,
      staticTestCandidateSnapshotId: projectsTable.staticTestCandidateSnapshotId,
      runningTestSnapshotId: projectsTable.runningTestSnapshotId,
      testedSnapshotId: projectsTable.testedSnapshotId,
      activePreviewSessionId: projectsTable.activePreviewSessionId,
      containerId: projectsTable.containerId,
      stack: projectsTable.stack,
      builderMode: projectsTable.builderMode,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    testingStatus: project.testingStatus,
    testContainerStatus: project.testContainerStatus,
    testContainerUrl: project.testContainerUrl,
    testingCandidateSnapshotId: project.testingCandidateSnapshotId,
    staticTestCandidateSnapshotId: project.staticTestCandidateSnapshotId,
    runningTestSnapshotId: project.runningTestSnapshotId,
    testedSnapshotId: project.testedSnapshotId,
    activePreviewSessionId: project.activePreviewSessionId,
    isFullStack: isFullStack(project),
  });
});

// ── POST /projects/:id/preview-env/start ─────────────────────────────────────
router.post("/projects/:id/preview-env/start", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Snapshot current project files into an immutable candidate.
  const files = await db
    .select({
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    res.status(422).json({ error: "Project has no files. Build the project first." });
    return;
  }

  const [candidateVersion] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: `Test candidate — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
      note: `Immutable test candidate snapshot. ${files.length} file(s). Created by ${req.userId ?? "unknown"}.`,
      environment: "preview",
      filesSnapshot: files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    })
    .returning({ id: projectVersionsTable.id });

  const candidateId = candidateVersion?.id;
  if (!candidateId) {
    res.status(500).json({ error: "Failed to create candidate snapshot." });
    return;
  }

  const fullStack = isFullStack(project);

  if (!fullStack) {
    // Static / React-Vite: no container needed.
    // The frontend will render the snapshot in an isolated WebContainer instance.
    await db
      .update(projectsTable)
      .set({
        testingStatus: "ready",
        testingCandidateSnapshotId: candidateId,
        staticTestCandidateSnapshotId: candidateId,
        testedSnapshotId: null,
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, projectId));

    res.json({
      ok: true,
      candidateSnapshotId: candidateId,
      testingStatus: "ready",
      isFullStack: false,
      message: "Test candidate created. Use Test Preview to load it in an isolated environment.",
    });
    return;
  }

  // Full-stack: start a dedicated test container in the background.
  await db
    .update(projectsTable)
    .set({
      testingStatus: "building",
      testingCandidateSnapshotId: candidateId,
      testedSnapshotId: null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  // Launch container asynchronously — client polls /status.
  setImmediate(async () => {
    try {
      await startTestContainer(project, projectId, candidateId, files);
    } catch (err) {
      logger.error({ err, projectId }, "Failed to start test container");
      await db
        .update(projectsTable)
        .set({ testingStatus: "failed", testContainerStatus: "error", updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));
    }
  });

  res.json({
    ok: true,
    candidateSnapshotId: candidateId,
    testingStatus: "building",
    isFullStack: true,
    message:
      "Test candidate created. Container is starting — poll /preview-env/status for updates.",
  });
});

// ── POST /projects/:id/preview-env/rebuild ────────────────────────────────────
router.post("/projects/:id/preview-env/rebuild", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Stop the existing test container first (non-fatal).
  if (project.testContainerId) {
    try {
      await destroyContainer(project.testContainerId, projectId);
    } catch (err) {
      logger.warn(
        { err, projectId },
        "Failed to stop old test container during rebuild — continuing",
      );
    }
  }

  // Revoke the active preview session.
  if (project.activePreviewSessionId) {
    await db
      .update(previewSessionsTable)
      .set({ revokedAt: new Date(), revokeReason: "rebuild" })
      .where(eq(previewSessionsTable.sessionId, project.activePreviewSessionId));
  }

  // Clear state, then delegate to start logic.
  await db
    .update(projectsTable)
    .set({
      testContainerId: null,
      testContainerUrl: null,
      testContainerStatus: "stopped",
      runningTestSnapshotId: null,
      testingCandidateSnapshotId: null,
      testedSnapshotId: null,
      testingStatus: "idle",
      activePreviewSessionId: null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  // Snapshot current files.
  const files = await db
    .select({
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (files.length === 0) {
    res.status(422).json({ error: "Project has no files." });
    return;
  }

  const [candidateVersion] = await db
    .insert(projectVersionsTable)
    .values({
      projectId,
      label: `Test candidate (rebuild) — ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`,
      note: `Rebuild test candidate. ${files.length} file(s). Actor: ${req.userId ?? "unknown"}.`,
      environment: "preview",
      filesSnapshot: files.map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    })
    .returning({ id: projectVersionsTable.id });

  const candidateId = candidateVersion?.id;
  if (!candidateId) {
    res.status(500).json({ error: "Failed to create rebuild candidate snapshot." });
    return;
  }

  const fullStack = isFullStack(project);
  if (!fullStack) {
    await db
      .update(projectsTable)
      .set({
        testingStatus: "ready",
        testingCandidateSnapshotId: candidateId,
        staticTestCandidateSnapshotId: candidateId,
        testedSnapshotId: null,
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, projectId));
    res.json({
      ok: true,
      candidateSnapshotId: candidateId,
      testingStatus: "ready",
      isFullStack: false,
    });
    return;
  }

  await db
    .update(projectsTable)
    .set({
      testingStatus: "building",
      testingCandidateSnapshotId: candidateId,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  setImmediate(async () => {
    try {
      // Reload project from DB (was mutated above).
      const [fresh] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
      if (fresh) await startTestContainer(fresh, projectId, candidateId, files);
    } catch (err) {
      logger.error({ err, projectId }, "Failed to start test container on rebuild");
      await db
        .update(projectsTable)
        .set({ testingStatus: "failed", testContainerStatus: "error", updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));
    }
  });

  res.json({
    ok: true,
    candidateSnapshotId: candidateId,
    testingStatus: "building",
    isFullStack: true,
  });
});

// ── POST /projects/:id/preview-env/stop ──────────────────────────────────────
router.post("/projects/:id/preview-env/stop", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select({
      testContainerId: projectsTable.testContainerId,
      activePreviewSessionId: projectsTable.activePreviewSessionId,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.testContainerId) {
    try {
      await destroyContainer(project.testContainerId, projectId);
    } catch (err) {
      logger.warn(
        { err, projectId },
        "Failed to stop test container during explicit stop — continuing",
      );
    }
  }

  if (project.activePreviewSessionId) {
    await db
      .update(previewSessionsTable)
      .set({ revokedAt: new Date(), revokeReason: "user-stopped" })
      .where(eq(previewSessionsTable.sessionId, project.activePreviewSessionId));
  }

  await db
    .update(projectsTable)
    .set({
      testContainerId: null,
      testContainerUrl: null,
      testContainerStatus: "stopped",
      activePreviewSessionId: null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  res.json({ ok: true, message: "Test container stopped." });
});

// ── POST /projects/:id/preview-env/approve ───────────────────────────────────
/**
 * Approve the current testing candidate (6 preconditions enforced).
 * On success: sets testedSnapshotId = testingCandidateSnapshotId, testingStatus = 'passed'.
 * Also sets testingApprovedAt + testingApprovedBy on the version row.
 */
router.post("/projects/:id/preview-env/approve", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // ── Precondition 1: testing candidate must exist ────────────────────────
  if (!project.testingCandidateSnapshotId) {
    res.status(422).json({
      error: "No testing candidate snapshot found. Start a test preview first.",
      code: "no_candidate",
    });
    return;
  }

  // ── Precondition 2: testingStatus must be 'ready' ──────────────────────
  if (project.testingStatus !== "ready") {
    res.status(422).json({
      error: `Testing status is '${project.testingStatus}'. The test environment must be ready before approving.`,
      code: "not_ready",
      testingStatus: project.testingStatus,
    });
    return;
  }

  const fullStack = isFullStack(project);

  if (fullStack) {
    // ── Precondition 3: test container must be running ───────────────────
    if (project.testContainerStatus !== "running") {
      res.status(422).json({
        error: `Test container is '${project.testContainerStatus}', not running. The container must be healthy before approving.`,
        code: "container_not_running",
        testContainerStatus: project.testContainerStatus,
      });
      return;
    }

    // ── Precondition 4: running snapshot must match the candidate ────────
    if (project.runningTestSnapshotId !== project.testingCandidateSnapshotId) {
      res.status(422).json({
        error:
          "The test container is running a different snapshot than the current candidate. Rebuild the test environment.",
        code: "snapshot_mismatch",
        runningTestSnapshotId: project.runningTestSnapshotId,
        testingCandidateSnapshotId: project.testingCandidateSnapshotId,
      });
      return;
    }
  }

  // ── Precondition 5: no unresolved critical security findings ───────────
  const criticalFindings = await getUnresolvedCriticalFindings(projectId, []);
  if (criticalFindings.length > 0) {
    res.status(422).json({
      error: `${criticalFindings.length} unresolved critical security finding(s) must be addressed before approving.`,
      code: "critical_findings",
      findings: criticalFindings.map((f) => ({
        checkName: f.checkName,
        file: f.finding.file,
        message: f.finding.message,
      })),
    });
    return;
  }

  // ── Precondition 6: migration status must not be 'failed' ──────────────
  const [candidateVersion] = await db
    .select({
      migrationStatus: projectVersionsTable.migrationStatus,
      testingApprovedAt: projectVersionsTable.testingApprovedAt,
    })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.id, project.testingCandidateSnapshotId));

  if (!candidateVersion) {
    res
      .status(422)
      .json({ error: "Testing candidate snapshot not found.", code: "version_missing" });
    return;
  }
  if (candidateVersion.migrationStatus === "failed") {
    res.status(422).json({
      error:
        "Preview database migration failed for this candidate. Fix migrations before approving.",
      code: "migration_failed",
    });
    return;
  }

  // All preconditions met — mark as approved.
  const now = new Date();

  await db
    .update(projectVersionsTable)
    .set({ testingApprovedAt: now, testingApprovedBy: req.userId ?? null })
    .where(eq(projectVersionsTable.id, project.testingCandidateSnapshotId));

  await db
    .update(projectsTable)
    .set({
      testedSnapshotId: project.testingCandidateSnapshotId,
      testingStatus: "passed",
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  res.json({
    ok: true,
    testedSnapshotId: project.testingCandidateSnapshotId,
    approvedAt: now.toISOString(),
    message: "Testing approved. This snapshot is now eligible for production publish.",
  });
});

// ── GET /projects/:id/preview-env/session ─────────────────────────────────────
/**
 * Returns the active preview session and launch URL.
 * Creates a new session if none exists or the existing one is revoked/expired.
 * The launch token is single-use and expires in 10 minutes.
 */
router.get("/projects/:id/preview-env/session", requireProjectOwnership, async (req, res) => {
  const projectId = Number(req.params.id);

  const [project] = await db
    .select({
      activePreviewSessionId: projectsTable.activePreviewSessionId,
      testContainerStatus: projectsTable.testContainerStatus,
      testingStatus: projectsTable.testingStatus,
      deletedAt: projectsTable.deletedAt,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project || project.deletedAt) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.testContainerStatus !== "running") {
    res.status(422).json({
      error: "Test container is not running. Start the test environment first.",
      testContainerStatus: project.testContainerStatus,
    });
    return;
  }

  // Check if an active, non-revoked, non-expired session exists.
  let sessionId: string | null = project.activePreviewSessionId ?? null;
  if (sessionId) {
    const [existing] = await db
      .select({
        revokedAt: previewSessionsTable.revokedAt,
        expiresAt: previewSessionsTable.expiresAt,
      })
      .from(previewSessionsTable)
      .where(eq(previewSessionsTable.sessionId, sessionId));

    if (!existing || existing.revokedAt || new Date() > existing.expiresAt) {
      sessionId = null;
    }
  }

  // Create a new session if needed.
  if (!sessionId) {
    sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await db.insert(previewSessionsTable).values({
      sessionId,
      projectId,
      userId: req.userId ?? "unknown",
      launchTokenHash: "", // Will be updated below
      expiresAt,
    });

    await db
      .update(projectsTable)
      .set({ activePreviewSessionId: sessionId, updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));
  }

  // Issue a fresh one-time launch token.
  const launchToken = generateLaunchToken();
  const tokenHash = hashLaunchToken(launchToken);
  const tokenExpiresAt = new Date(Date.now() + LAUNCH_TOKEN_TTL_MS);

  await db
    .update(previewSessionsTable)
    .set({
      launchTokenHash: tokenHash,
      launchTokenUsed: false,
      expiresAt: tokenExpiresAt, // The token window is the new expiry
    })
    .where(eq(previewSessionsTable.sessionId, sessionId));

  const previewUrl = `https://${sessionId}.preview.${PLATFORM_DOMAIN}`;
  const launchUrl = `${previewUrl}/__preview-launch?t=${launchToken}`;

  res.json({
    sessionId,
    previewUrl,
    launchUrl,
    expiresAt: tokenExpiresAt.toISOString(),
    message:
      "Open launchUrl in the same browser to start the preview session. Token is single-use and expires in 10 minutes.",
  });
});

// ── Shared helper: start a test container for a full-stack project ────────────
async function startTestContainer(
  project: typeof projectsTable.$inferSelect,
  projectId: number,
  candidateId: number,
  files: Array<{ path: string; content: string | null; mimeType: string | null }>,
): Promise<void> {
  const secretRows = await db
    .select({
      name: secretsTable.name,
      valueEncrypted: secretsTable.valueEncrypted,
      isPreviewSafe: secretsTable.isPreviewSafe,
    })
    .from(secretsTable)
    .where(eq(secretsTable.projectId, projectId));

  const envVars: Record<string, string> = {
    PROJECT_ID: String(projectId),
    NODE_ENV: "testing",
    PORT: "3000",
  };

  // Only inject preview-safe secrets into the test container.
  for (const s of secretRows) {
    if (!s.isPreviewSafe) continue;
    try {
      envVars[s.name] = encryptionService.decrypt(s.valueEncrypted);
    } catch {
      // skip malformed secrets
    }
  }

  const previewDbUrl = project.previewDbUrl
    ? encryptionService.decrypt(project.previewDbUrl)
    : null;
  if (previewDbUrl) {
    envVars["DATABASE_URL"] = previewDbUrl;
  }

  // Stop existing test container if any (non-fatal).
  if (project.testContainerId) {
    await destroyContainer(project.testContainerId, projectId).catch(() => {});
  }

  // Create a new Fly machine for the test environment.
  const containerInfo = await createContainer(projectId, project.stack ?? null, envVars);
  if (!containerInfo) {
    throw new Error(
      "Container creation failed — FLY_API_TOKEN may be missing or Fly returned an error",
    );
  }

  // Wait for the machine to enter "started" state (poll up to 60 s).
  const machineReady = await pollMachineReady(containerInfo.containerId, 60);
  if (!machineReady) {
    await destroyContainer(containerInfo.containerId, projectId).catch(() => {});
    throw new Error(`Test container machine did not reach started state within 60 s`);
  }

  // Sync snapshot files.
  await syncFilesToContainer(
    containerInfo.containerId,
    projectId,
    files.map((f) => ({ path: f.path, content: f.content ?? "" })),
  );

  // For Node.js projects: install dependencies and start the app.
  const hasPackageJson = files.some((f) => f.path === "package.json");
  if (hasPackageJson) {
    await execInContainer(
      containerInfo.containerId,
      ["npm", "install", "--prefer-offline", "--no-audit"],
      projectId,
    );
    // Run build if a build script is present (non-fatal if it fails — app may not need it).
    await execInContainer(containerInfo.containerId, ["npm", "run", "build"], projectId).catch(
      () => {},
    );
  }

  // Start the app process in the background.
  await execInContainer(
    containerInfo.containerId,
    ["/bin/sh", "-c", "cd /app && nohup npm start &>/tmp/app.log &"],
    projectId,
  );

  if (!containerInfo.containerUrl) {
    throw new Error("Container created but no URL was returned — cannot run health check");
  }

  // Health check — poll until the app responds or timeout.
  const healthPath = healthCheckPathForStack(project.stack);
  const healthy = await waitForContainerHealthy(containerInfo.containerUrl, healthPath, 90_000);

  if (!healthy) {
    await destroyContainer(containerInfo.containerId, projectId).catch(() => {});
    throw new Error(
      `Test container health check timed out at ${containerInfo.containerUrl}${healthPath}`,
    );
  }

  // All good — record test container in DB.
  await db
    .update(projectsTable)
    .set({
      testContainerId: containerInfo.containerId,
      testContainerUrl: containerInfo.containerUrl,
      testContainerStatus: "running",
      runningTestSnapshotId: candidateId,
      testingStatus: "ready",
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  logger.info(
    { projectId, candidateId, containerId: containerInfo.containerId },
    "Test container started and healthy",
  );
}

/**
 * Poll Fly machine status until it enters 'started' or the timeout elapses.
 * Returns true if the machine became ready, false on timeout.
 */
async function pollMachineReady(machineId: string, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const status = await getContainerStatus(machineId);
      if (status === "running") return true;
    } catch {
      // transient error — keep polling
    }
    await new Promise<void>((r) => setTimeout(r, 3_000));
  }
  return false;
}

export default router;
