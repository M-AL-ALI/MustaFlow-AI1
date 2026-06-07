import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  oraxRepositoriesTable,
  oraxRepositoryScansTable,
  oraxTaskApprovalsTable,
  oraxTaskArtifactsTable,
  oraxTaskMessagesTable,
  oraxTasksTable,
  ORAX_PROVIDERS,
  ORAX_TASK_KINDS,
  type OraxTaskApproval,
  type OraxRepository,
  type OraxTask,
  type OraxTaskArtifact,
} from "@workspace/db";
import { generateOraxDraftPatch } from "../lib/orax-draft-patch";
import {
  buildOraxTaskPlan,
  normalizeOraxFileReadPaths,
  ORAX_FILE_READ_LIMITS,
  parseRepositoryLocator,
} from "../lib/orax";
import {
  createGithubPullRequestFromFiles,
  downloadGithubRepositoryTarball,
  readGithubRepositoryFiles,
  scanGithubRepository,
  verifyGithubReadOnlyToken,
} from "../lib/orax-github";
import { buildOraxSandboxPatch, runOraxSandboxValidation } from "../lib/orax-sandbox";
import {
  hasOraxWorkspaceCommandIds,
  normalizeOraxSandboxCommandIds,
  ORAX_MAX_SANDBOX_COMMANDS,
  ORAX_SANDBOX_COMMAND_IDS,
  runOraxIsolatedWorkspaceChecks,
} from "../lib/orax-command-sandbox";
import { logger } from "../lib/logger";
import { encryptionService } from "../lib/encryption";

const router = Router();

const repositorySchema = z.object({
  repositoryUrl: z.string().min(8).max(2000),
  defaultBranch: z.string().min(1).max(120).optional(),
  provider: z.enum(ORAX_PROVIDERS).optional(),
});

const createTaskSchema = z.object({
  repositoryId: z.number().int().positive(),
  kind: z.enum(ORAX_TASK_KINDS).default("analyze"),
  prompt: z.string().min(3).max(8000),
  title: z.string().min(1).max(140).optional(),
});

const taskMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
});

const githubConnectSchema = z.object({
  token: z.string().min(8).max(5000),
});

const scanRepositorySchema = z.object({
  branch: z.string().min(1).max(120).optional(),
});

const createApprovalSchema = z.object({
  action: z.literal("read_files").default("read_files"),
  paths: z.array(z.string().min(1).max(300)).min(1).max(ORAX_FILE_READ_LIMITS.maxFiles),
  branch: z.string().min(1).max(120).optional(),
  reason: z.string().max(1000).optional(),
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
});

const draftPatchSchema = z.object({
  approvalId: z.number().int().positive(),
  instructions: z.string().max(2000).optional(),
});

const sandboxApprovalSchema = z.object({
  artifactId: z.number().int().positive(),
  reason: z.string().max(1000).optional(),
});

const safeCheckApprovalSchema = z.object({
  artifactId: z.number().int().positive(),
  commands: z
    .array(z.enum(ORAX_SANDBOX_COMMAND_IDS))
    .min(1)
    .max(ORAX_MAX_SANDBOX_COMMANDS)
    .optional(),
  reason: z.string().max(1000).optional(),
});

const githubPrApprovalSchema = z.object({
  artifactId: z.number().int().positive(),
  title: z.string().min(1).max(180).optional(),
  body: z.string().max(4000).optional(),
  confirmationText: z.literal("CREATE PR"),
  reason: z.string().max(1000).optional(),
});

type OraxTaskActionSuggestion = {
  type:
    | "read_files"
    | "draft_patch"
    | "sandbox_run"
    | "controlled_checks"
    | "github_pr"
    | "review_pending_approval";
  title: string;
  description: string;
  buttonLabel?: string;
  paths?: string[];
  reason?: string;
  instructions?: string;
  artifactId?: number;
  approvalId?: number;
  commands?: string[];
  requiresManualConfirmation?: boolean;
};

type OraxTimelineMessageInput = {
  userId: string;
  task: OraxTask;
  role?: "system" | "tool";
  event: string;
  content: string;
  approvalId?: number | null;
  artifactId?: number | null;
  metadata?: Record<string, unknown>;
};

type OraxCheckpointSummary = {
  goal: string;
  status: string;
  filesReviewed: string[];
  approvals: {
    pending: number;
    completed: number;
    failed: number;
    denied: number;
    total: number;
  };
  artifacts: {
    draftPatches: number;
    sandboxResults: number;
    commandResults: number;
    githubPrResults: number;
    total: number;
  };
  latestBlocker: string | null;
  nextStep: string;
  updatedAt: string;
};

router.get("/orax/capabilities", (_req, res) => {
  res.json({
    product: "ORAX",
    phase: "isolated_workspace_execution",
    mode: "approval_gated_repository_change_validation",
    available: [
      "Register repository metadata",
      "Connect a GitHub token for read-only repository scans",
      "Scan repository metadata, branches, and file tree summaries",
      "Create coding-agent task plans",
      "Request approval to read selected source files",
      "Generate draft patch previews from approved file reads",
      "Request approval to validate draft patches in an isolated sandbox",
      "Request approval to run controlled syntax, static, and allowlisted workspace checks",
      "Create GitHub branches and pull requests after explicit approval",
      "Discuss each coding task in a persistent ORAX-only task conversation",
      "Map task chat into approval-ready suggestions without auto-executing them",
      "Prepare approval requests from task-chat suggestions only after explicit confirmation",
      "Store ORAX task history separately from Ora and AI Builder",
    ],
    lockedUntilApprovalLayer: [
      "Clone private repositories",
      "Edit files",
      "Run unrestricted terminal commands",
      "Run non-allowlisted commands or deployment scripts",
      "Push directly to the default branch",
      "Open pull requests without explicit approval",
      "Deploy applications",
    ],
  });
});

router.get("/orax/repositories", async (req, res) => {
  const userId = req.userId!;
  try {
    const repositories = await db
      .select()
      .from(oraxRepositoriesTable)
      .where(
        and(eq(oraxRepositoriesTable.userId, userId), isNull(oraxRepositoriesTable.archivedAt)),
      )
      .orderBy(desc(oraxRepositoriesTable.updatedAt));
    res.json({ repositories: repositories.map(toRepositorySummary) });
  } catch (err) {
    logger.error({ component: "orax", err }, "Failed to list ORAX repositories");
    res.status(500).json({ error: "Failed to load ORAX repositories" });
  }
});

router.post("/orax/repositories", async (req, res) => {
  const userId = req.userId!;
  const parsed = repositorySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid repository metadata" });
    return;
  }

  let locator;
  try {
    locator = parseRepositoryLocator(parsed.data);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid repository URL" });
    return;
  }

  try {
    const [repository] = await db
      .insert(oraxRepositoriesTable)
      .values({
        userId,
        provider: locator.provider,
        owner: locator.owner,
        name: locator.name,
        repositoryUrl: locator.repositoryUrl,
        defaultBranch: locator.defaultBranch,
        connectionStatus: "metadata_only",
      })
      .returning();

    res.status(201).json({ repository: toRepositorySummary(repository) });
  } catch (err) {
    logger.error({ component: "orax", err }, "Failed to create ORAX repository");
    res.status(500).json({ error: "Failed to save ORAX repository" });
  }
});

router.post("/orax/repositories/:id/github/connect", async (req, res) => {
  const userId = req.userId!;
  const repositoryId = Number(req.params.id);
  if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
    res.status(400).json({ error: "Invalid repository id" });
    return;
  }

  const parsed = githubConnectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid GitHub token" });
    return;
  }

  try {
    const repository = await loadOwnedRepository(userId, repositoryId);
    if (!repository) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (repository.provider !== "github") {
      res.status(400).json({ error: "Read-only GitHub connection only supports GitHub repos" });
      return;
    }

    const token = parsed.data.token.trim();
    const verified = await verifyGithubReadOnlyToken({
      owner: repository.owner,
      repo: repository.name,
      token,
    });
    const [updated] = await db
      .update(oraxRepositoriesTable)
      .set({
        defaultBranch: verified.defaultBranch || repository.defaultBranch,
        repositoryUrl: verified.htmlUrl || repository.repositoryUrl,
        connectionStatus: "read_only",
        githubAccountName: verified.login,
        tokenScopes: verified.scopes,
        encryptedToken: encryptionService.encrypt(token),
        connectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(oraxRepositoriesTable.id, repository.id))
      .returning();

    res.json({ repository: toRepositorySummary(updated) });
  } catch (err) {
    logger.error({ component: "orax", err, repositoryId }, "Failed to connect ORAX GitHub token");
    res.status(502).json({ error: "Could not verify GitHub repository access" });
  }
});

router.get("/orax/repositories/:id/scans", async (req, res) => {
  const userId = req.userId!;
  const repositoryId = Number(req.params.id);
  if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
    res.status(400).json({ error: "Invalid repository id" });
    return;
  }

  try {
    const repository = await loadOwnedRepository(userId, repositoryId);
    if (!repository) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    const scans = await db
      .select()
      .from(oraxRepositoryScansTable)
      .where(
        and(
          eq(oraxRepositoryScansTable.userId, userId),
          eq(oraxRepositoryScansTable.repositoryId, repositoryId),
        ),
      )
      .orderBy(desc(oraxRepositoryScansTable.createdAt))
      .limit(10);

    res.json({ scans });
  } catch (err) {
    logger.error({ component: "orax", err, repositoryId }, "Failed to list ORAX scans");
    res.status(500).json({ error: "Failed to load ORAX scans" });
  }
});

router.post("/orax/repositories/:id/scan", async (req, res) => {
  const userId = req.userId!;
  const repositoryId = Number(req.params.id);
  if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
    res.status(400).json({ error: "Invalid repository id" });
    return;
  }

  const parsed = scanRepositorySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid scan request" });
    return;
  }

  let repository: OraxRepository | undefined;
  const branchOverride = parsed.data.branch?.trim();
  try {
    repository = await loadOwnedRepository(userId, repositoryId);
    if (!repository) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (repository.provider !== "github") {
      res.status(400).json({ error: "Read-only scans currently support GitHub repositories" });
      return;
    }

    await db
      .update(oraxRepositoriesTable)
      .set({ scanStatus: "scanning", updatedAt: new Date() })
      .where(eq(oraxRepositoriesTable.id, repository.id));

    const token = repository.encryptedToken
      ? encryptionService.decrypt(repository.encryptedToken)
      : undefined;
    const summary = await scanGithubRepository({
      owner: repository.owner,
      repo: repository.name,
      branch: branchOverride || repository.defaultBranch,
      token,
    });

    const completedAt = new Date();
    const [scan] = await db
      .insert(oraxRepositoryScansTable)
      .values({
        userId,
        repositoryId: repository.id,
        status: "completed",
        branch: summary.branch,
        commitSha: summary.commitSha,
        fileCount: summary.fileCount,
        directoryCount: summary.directoryCount,
        totalBytes: summary.totalBytes,
        summary,
        completedAt,
      })
      .returning();

    const [updated] = await db
      .update(oraxRepositoriesTable)
      .set({
        defaultBranch: summary.repo.defaultBranch,
        repositoryUrl: summary.repo.htmlUrl,
        lastScanAt: completedAt,
        scanStatus: "idle",
        updatedAt: completedAt,
      })
      .where(eq(oraxRepositoriesTable.id, repository.id))
      .returning();

    res.status(201).json({ repository: toRepositorySummary(updated), scan });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Could not scan GitHub repository";
    logger.error({ component: "orax", err, repositoryId }, "Failed to scan ORAX repository");
    if (repository) {
      await db
        .insert(oraxRepositoryScansTable)
        .values({
          userId,
          repositoryId: repository.id,
          status: "failed",
          branch: branchOverride || repository.defaultBranch,
          error,
          completedAt: new Date(),
        })
        .catch((insertErr) => {
          logger.error(
            { component: "orax", err: insertErr, repositoryId },
            "Failed to persist ORAX scan failure",
          );
        });
      await db
        .update(oraxRepositoriesTable)
        .set({ scanStatus: "error", updatedAt: new Date() })
        .where(eq(oraxRepositoriesTable.id, repository.id))
        .catch((updateErr) => {
          logger.error(
            { component: "orax", err: updateErr, repositoryId },
            "Failed to update ORAX scan failure status",
          );
        });
    }
    res.status(502).json({ error: "Could not scan GitHub repository" });
  }
});

router.get("/orax/tasks", async (req, res) => {
  const userId = req.userId!;
  try {
    const tasks = await db
      .select()
      .from(oraxTasksTable)
      .where(and(eq(oraxTasksTable.userId, userId), isNull(oraxTasksTable.archivedAt)))
      .orderBy(desc(oraxTasksTable.createdAt));
    res.json({ tasks });
  } catch (err) {
    logger.error({ component: "orax", err }, "Failed to list ORAX tasks");
    res.status(500).json({ error: "Failed to load ORAX tasks" });
  }
});

router.get("/orax/tasks/:id/messages", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const messages = await db
      .select()
      .from(oraxTaskMessagesTable)
      .where(
        and(
          eq(oraxTaskMessagesTable.userId, userId),
          eq(oraxTaskMessagesTable.taskId, taskId),
          isNull(oraxTaskMessagesTable.archivedAt),
        ),
      )
      .orderBy(asc(oraxTaskMessagesTable.createdAt));
    res.json({ messages });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to list ORAX task messages");
    res.status(500).json({ error: "Failed to load ORAX task messages" });
  }
});

router.post("/orax/tasks/:id/messages", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const parsed = taskMessageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid message" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const approvals = await db
      .select()
      .from(oraxTaskApprovalsTable)
      .where(
        and(eq(oraxTaskApprovalsTable.userId, userId), eq(oraxTaskApprovalsTable.taskId, taskId)),
      )
      .orderBy(desc(oraxTaskApprovalsTable.createdAt));
    const artifacts = await db
      .select()
      .from(oraxTaskArtifactsTable)
      .where(
        and(
          eq(oraxTaskArtifactsTable.userId, userId),
          eq(oraxTaskArtifactsTable.taskId, taskId),
          isNull(oraxTaskArtifactsTable.archivedAt),
        ),
      )
      .orderBy(desc(oraxTaskArtifactsTable.createdAt));

    const now = new Date();
    const [message] = await db
      .insert(oraxTaskMessagesTable)
      .values({
        userId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        role: "user",
        content: parsed.data.content,
        metadata: { source: "orax-task-thread" },
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const actionSuggestions = buildOraxTaskActionSuggestions({
      task,
      approvals,
      artifacts,
      userMessage: parsed.data.content,
    });
    const assistantContent = buildOraxTaskThreadReply({
      task,
      approvals,
      artifacts,
      actionSuggestions,
    });
    const [assistantMessage] = await db
      .insert(oraxTaskMessagesTable)
      .values({
        userId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        role: "assistant",
        content: assistantContent,
        metadata: {
          source: "orax-task-thread",
          mode: "status_discussion",
          taskStatus: task.status,
          approvalCount: approvals.length,
          artifactCount: artifacts.length,
          actionSuggestions,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({ updatedAt: new Date() })
      .where(eq(oraxTasksTable.id, task.id));

    res.status(201).json({ messages: [message, assistantMessage] });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to append ORAX task message");
    res.status(500).json({ error: "Failed to save ORAX task message" });
  }
});

router.get("/orax/tasks/:id/approvals", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const approvals = await db
      .select()
      .from(oraxTaskApprovalsTable)
      .where(
        and(eq(oraxTaskApprovalsTable.userId, userId), eq(oraxTaskApprovalsTable.taskId, taskId)),
      )
      .orderBy(desc(oraxTaskApprovalsTable.createdAt));
    res.json({ approvals });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to list ORAX approvals");
    res.status(500).json({ error: "Failed to load ORAX approvals" });
  }
});

router.get("/orax/tasks/:id/artifacts", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const artifacts = await db
      .select()
      .from(oraxTaskArtifactsTable)
      .where(
        and(
          eq(oraxTaskArtifactsTable.userId, userId),
          eq(oraxTaskArtifactsTable.taskId, taskId),
          isNull(oraxTaskArtifactsTable.archivedAt),
        ),
      )
      .orderBy(desc(oraxTaskArtifactsTable.createdAt));
    res.json({ artifacts });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to list ORAX artifacts");
    res.status(500).json({ error: "Failed to load ORAX artifacts" });
  }
});

router.post("/orax/tasks/:id/approvals", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const parsed = createApprovalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid approval request" });
    return;
  }

  let paths: string[];
  try {
    paths = normalizeOraxFileReadPaths(parsed.data.paths);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid file paths" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const repository = await loadOwnedRepository(userId, task.repositoryId);
    if (!repository) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (repository.provider !== "github") {
      res.status(400).json({ error: "Approved file reads currently support GitHub repositories" });
      return;
    }

    const request = {
      action: parsed.data.action,
      paths,
      branch: parsed.data.branch?.trim() || repository.defaultBranch,
      reason: parsed.data.reason?.trim() || null,
      limits: ORAX_FILE_READ_LIMITS,
    };
    const [approval] = await db
      .insert(oraxTaskApprovalsTable)
      .values({
        userId,
        repositoryId: repository.id,
        taskId: task.id,
        action: parsed.data.action,
        status: "pending",
        request,
        riskSummary:
          "ORAX will read selected repository files only. It will not edit files, run commands, push branches, open PRs, or deploy.",
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "system",
      event: "approval_requested",
      content: `File-read approval requested for ${paths.length} path${paths.length === 1 ? "" : "s"}.`,
      approvalId: approval.id,
      metadata: {
        action: approval.action,
        paths,
        branch: request.branch,
      },
    });

    res.status(201).json({ approval });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to create ORAX approval");
    res.status(500).json({ error: "Failed to create ORAX approval" });
  }
});

router.post("/orax/tasks/:id/draft-patch", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const parsed = draftPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid draft patch request" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const repository = await loadOwnedRepository(userId, task.repositoryId);
    const approval = await loadOwnedApproval(userId, parsed.data.approvalId);
    if (!repository || !approval || approval.taskId !== task.id) {
      res.status(404).json({ error: "Task, repository, or approval not found" });
      return;
    }
    if (approval.action !== "read_files" || !["approved", "completed"].includes(approval.status)) {
      res.status(409).json({ error: "Draft patch requires an approved file-read request" });
      return;
    }

    const request = approval.request as { paths?: string[]; branch?: string };
    const paths = normalizeOraxFileReadPaths(request.paths ?? []);
    const branch = request.branch || repository.defaultBranch;
    const token = repository.encryptedToken
      ? encryptionService.decrypt(repository.encryptedToken)
      : undefined;
    const readResult = await readGithubRepositoryFiles({
      owner: repository.owner,
      repo: repository.name,
      branch,
      paths,
      token,
      maxFileBytes: ORAX_FILE_READ_LIMITS.maxFileBytes,
      maxTotalBytes: ORAX_FILE_READ_LIMITS.maxTotalBytes,
    });

    if (!readResult.files.length) {
      res.status(409).json({ error: "No approved files could be read for draft patch generation" });
      return;
    }

    const generated = await generateOraxDraftPatch({
      repositoryLabel: `${repository.owner}/${repository.name}`,
      taskPrompt: task.prompt,
      instructions: parsed.data.instructions,
      branch,
      files: readResult.files.map((file) => ({
        path: file.path,
        content: file.content,
        size: file.size,
        sha: file.sha,
      })),
    });

    const payload = {
      branch,
      approvalId: approval.id,
      model: process.env.ORAX_DRAFT_PATCH_MODEL || "gpt-5-mini",
      generatedAt: new Date().toISOString(),
      filesRead: readResult.files.map((file) => ({
        path: file.path,
        sha: file.sha,
        size: file.size,
      })),
      skipped: readResult.skipped,
      unifiedDiff: generated.unifiedDiff,
      explanation: generated.explanation,
      risks: generated.risks,
      tests: generated.tests,
    };

    const [artifact] = await db
      .insert(oraxTaskArtifactsTable)
      .values({
        userId,
        repositoryId: repository.id,
        taskId: task.id,
        approvalId: approval.id,
        type: "draft_patch",
        status: "draft",
        title: `Draft patch for ${task.title}`,
        summary: generated.summary,
        payload,
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        status: "awaiting_approval",
        result: {
          ...asRecord(task.result),
          draftPatch: {
            artifactId: artifact.id,
            summary: generated.summary,
            hasDiff: Boolean(generated.unifiedDiff.trim()),
          },
          message:
            "ORAX generated a draft patch preview. It has not applied files, run commands, pushed, opened a PR, or deployed.",
        },
        updatedAt: new Date(),
        completedAt: null,
      })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "tool",
      event: "draft_patch_generated",
      content: `Draft patch generated: ${generated.summary}`,
      approvalId: approval.id,
      artifactId: artifact.id,
      metadata: {
        artifactType: artifact.type,
        status: artifact.status,
        filesRead: readResult.files.length,
        skipped: readResult.skipped.length,
      },
    });

    res.status(201).json({ artifact });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to generate ORAX draft patch");
    res.status(502).json({ error: "Could not generate draft patch" });
  }
});

router.post("/orax/tasks/:id/sandbox-approvals", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const parsed = sandboxApprovalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid sandbox approval request" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    const artifact = await loadOwnedArtifact(userId, parsed.data.artifactId);
    if (!task || !artifact || artifact.taskId !== task.id || artifact.type !== "draft_patch") {
      res.status(404).json({ error: "Task or draft patch artifact not found" });
      return;
    }

    const payload = asRecord(artifact.payload);
    const unifiedDiff = typeof payload.unifiedDiff === "string" ? payload.unifiedDiff : "";
    if (!unifiedDiff.trim()) {
      res.status(409).json({ error: "Sandbox validation requires a draft patch diff" });
      return;
    }

    const [approval] = await db
      .insert(oraxTaskApprovalsTable)
      .values({
        userId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        action: "sandbox_run",
        status: "pending",
        request: {
          artifactId: artifact.id,
          reason: parsed.data.reason?.trim() || null,
          scope:
            "Validate this draft patch inside an isolated in-memory sandbox. No repository files will be changed.",
        },
        riskSummary:
          "ORAX will validate whether the draft patch applies to approved files. It will not write to the repository, run unrestricted commands, push, open a PR, or deploy.",
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "system",
      event: "approval_requested",
      content: `Sandbox validation approval requested for draft artifact #${artifact.id}.`,
      approvalId: approval.id,
      artifactId: artifact.id,
      metadata: {
        action: approval.action,
        draftArtifactId: artifact.id,
      },
    });

    res.status(201).json({ approval });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to create ORAX sandbox approval");
    res.status(500).json({ error: "Failed to create ORAX sandbox approval" });
  }
});

router.post("/orax/tasks/:id/command-approvals", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const parsed = safeCheckApprovalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid controlled-check approval request" });
    return;
  }

  let commands;
  try {
    commands = normalizeOraxSandboxCommandIds(parsed.data.commands);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid command list" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    const artifact = await loadOwnedArtifact(userId, parsed.data.artifactId);
    if (!task || !artifact || artifact.taskId !== task.id || artifact.type !== "sandbox_result") {
      res.status(404).json({ error: "Task or sandbox result artifact not found" });
      return;
    }

    const payload = asRecord(artifact.payload);
    if (artifact.status !== "completed" || payload.applied !== true) {
      res.status(409).json({ error: "Controlled checks require a passed sandbox result" });
      return;
    }

    const [approval] = await db
      .insert(oraxTaskApprovalsTable)
      .values({
        userId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        action: "safe_check",
        status: "pending",
        request: {
          artifactId: artifact.id,
          commands,
          reason: parsed.data.reason?.trim() || null,
          scope:
            "Run fixed ORAX-controlled checks. Package checks are limited to allowlisted pnpm commands in a temporary workspace. No arbitrary shell text, deployment, or default-branch write is allowed.",
        },
        riskSummary:
          "ORAX will run only fixed safe-check IDs. Allowlisted pnpm commands run in a temporary isolated workspace with a sanitized environment. It will not execute arbitrary shell commands, push, open a PR, or deploy.",
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "system",
      event: "approval_requested",
      content: `Controlled-check approval requested for sandbox artifact #${artifact.id}.`,
      approvalId: approval.id,
      artifactId: artifact.id,
      metadata: {
        action: approval.action,
        commands,
      },
    });

    res.status(201).json({ approval });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to create ORAX command approval");
    res.status(500).json({ error: "Failed to create ORAX command approval" });
  }
});

router.post("/orax/tasks/:id/github-pr-approvals", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const parsed = githubPrApprovalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid GitHub PR approval request" });
    return;
  }

  try {
    const task = await loadOwnedTask(userId, taskId);
    const artifact = await loadOwnedArtifact(userId, parsed.data.artifactId);
    if (!task || !artifact || artifact.taskId !== task.id || artifact.type !== "command_result") {
      res.status(404).json({ error: "Task or controlled-check artifact not found" });
      return;
    }

    const payload = asRecord(artifact.payload);
    if (payload.passed !== true || artifact.status !== "completed") {
      res.status(409).json({ error: "GitHub PR creation requires passed controlled checks" });
      return;
    }

    const [approval] = await db
      .insert(oraxTaskApprovalsTable)
      .values({
        userId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        action: "github_pr",
        status: "pending",
        request: {
          artifactId: artifact.id,
          title: parsed.data.title?.trim() || `ORAX: ${task.title}`,
          body: parsed.data.body?.trim() || null,
          confirmationText: parsed.data.confirmationText,
          reason: parsed.data.reason?.trim() || null,
          scope:
            "Create a new GitHub branch and pull request from this checked patch. The default branch will not be modified directly.",
        },
        riskSummary:
          "ORAX will create a new branch, commit the controlled-check-passed patch, and open a pull request. It will not push directly to the default branch, deploy, or run unrestricted terminal commands.",
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({ status: "awaiting_approval", updatedAt: new Date() })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "system",
      event: "approval_requested",
      content: `GitHub PR approval requested for controlled-check artifact #${artifact.id}.`,
      approvalId: approval.id,
      artifactId: artifact.id,
      metadata: {
        action: approval.action,
        title: parsed.data.title?.trim() || `ORAX: ${task.title}`,
      },
    });

    res.status(201).json({ approval });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to create ORAX GitHub PR approval");
    res.status(500).json({ error: "Failed to create ORAX GitHub PR approval" });
  }
});

router.patch("/orax/approvals/:id", async (req, res) => {
  const userId = req.userId!;
  const approvalId = Number(req.params.id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    res.status(400).json({ error: "Invalid approval id" });
    return;
  }

  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid approval decision" });
    return;
  }

  try {
    const approval = await loadOwnedApproval(userId, approvalId);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (approval.status !== "pending") {
      res.status(409).json({ error: "Approval has already been decided" });
      return;
    }

    const [updated] = await db
      .update(oraxTaskApprovalsTable)
      .set({ status: parsed.data.decision, decidedAt: new Date() })
      .where(eq(oraxTaskApprovalsTable.id, approval.id))
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        status: parsed.data.decision === "approved" ? "awaiting_approval" : "planned",
        updatedAt: new Date(),
      })
      .where(eq(oraxTasksTable.id, approval.taskId));

    const task = await loadOwnedTask(userId, approval.taskId);
    if (task) {
      await persistOraxTimelineMessage({
        userId,
        task,
        role: "system",
        event: "approval_decided",
        content: `Approval #${approval.id} ${parsed.data.decision}.`,
        approvalId: approval.id,
        metadata: {
          action: approval.action,
          decision: parsed.data.decision,
        },
      });
    }

    res.json({ approval: updated });
  } catch (err) {
    logger.error({ component: "orax", err, approvalId }, "Failed to decide ORAX approval");
    res.status(500).json({ error: "Failed to update ORAX approval" });
  }
});

router.post("/orax/approvals/:id/read-files", async (req, res) => {
  const userId = req.userId!;
  const approvalId = Number(req.params.id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    res.status(400).json({ error: "Invalid approval id" });
    return;
  }

  try {
    const approval = await loadOwnedApproval(userId, approvalId);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (approval.action !== "read_files") {
      res.status(400).json({ error: "Unsupported approval action" });
      return;
    }
    if (approval.status !== "approved") {
      res.status(409).json({ error: "File read requires an approved request" });
      return;
    }

    const task = await loadOwnedTask(userId, approval.taskId);
    const repository = await loadOwnedRepository(userId, approval.repositoryId);
    if (!task || !repository) {
      res.status(404).json({ error: "Task or repository not found" });
      return;
    }
    if (repository.provider !== "github") {
      res.status(400).json({ error: "Approved file reads currently support GitHub repositories" });
      return;
    }

    const request = approval.request as {
      paths?: string[];
      branch?: string;
    };
    const paths = normalizeOraxFileReadPaths(request.paths ?? []);
    const branch = request.branch || repository.defaultBranch;
    const token = repository.encryptedToken
      ? encryptionService.decrypt(repository.encryptedToken)
      : undefined;
    const readResult = await readGithubRepositoryFiles({
      owner: repository.owner,
      repo: repository.name,
      branch,
      paths,
      token,
      maxFileBytes: ORAX_FILE_READ_LIMITS.maxFileBytes,
      maxTotalBytes: ORAX_FILE_READ_LIMITS.maxTotalBytes,
    });

    const auditResult = {
      branch,
      totalBytes: readResult.totalBytes,
      files: readResult.files.map((file) => ({
        path: file.path,
        sha: file.sha,
        size: file.size,
        truncated: file.truncated,
      })),
      skipped: readResult.skipped,
    };

    const [updatedApproval] = await db
      .update(oraxTaskApprovalsTable)
      .set({
        status: readResult.files.length ? "completed" : "failed",
        result: auditResult,
        completedAt: new Date(),
      })
      .where(eq(oraxTaskApprovalsTable.id, approval.id))
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        status: readResult.files.length ? "completed" : "blocked",
        result: {
          ...asRecord(task.result),
          fileRead: auditResult,
          message: readResult.files.length
            ? "ORAX read the approved files. Editing, terminal execution, push, PR, and deploy remain locked."
            : "ORAX could not read the approved files.",
        },
        updatedAt: new Date(),
        completedAt: readResult.files.length ? new Date() : null,
      })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "tool",
      event: "files_read",
      content: readResult.files.length
        ? `Approved file read completed: ${readResult.files.length} file${readResult.files.length === 1 ? "" : "s"} read.`
        : "Approved file read completed with no readable files.",
      approvalId: updatedApproval.id,
      metadata: {
        branch,
        files: readResult.files.map((file) => file.path),
        skipped: readResult.skipped,
        totalBytes: readResult.totalBytes,
      },
    });

    res.json({
      approval: updatedApproval,
      branch,
      files: readResult.files,
      skipped: readResult.skipped,
      limits: ORAX_FILE_READ_LIMITS,
    });
  } catch (err) {
    logger.error({ component: "orax", err, approvalId }, "Failed to read approved ORAX files");
    res.status(502).json({ error: "Could not read approved files" });
  }
});

router.post("/orax/approvals/:id/run-sandbox", async (req, res) => {
  const userId = req.userId!;
  const approvalId = Number(req.params.id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    res.status(400).json({ error: "Invalid approval id" });
    return;
  }

  try {
    const approval = await loadOwnedApproval(userId, approvalId);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (approval.action !== "sandbox_run") {
      res.status(400).json({ error: "Unsupported approval action" });
      return;
    }
    if (approval.status !== "approved") {
      res.status(409).json({ error: "Sandbox validation requires an approved request" });
      return;
    }

    const task = await loadOwnedTask(userId, approval.taskId);
    const repository = await loadOwnedRepository(userId, approval.repositoryId);
    const request = asRecord(approval.request);
    const artifactId =
      typeof request.artifactId === "number" ? request.artifactId : Number(request.artifactId);
    const draftArtifact = Number.isInteger(artifactId)
      ? await loadOwnedArtifact(userId, artifactId)
      : undefined;
    if (!task || !repository || !draftArtifact || draftArtifact.taskId !== task.id) {
      res.status(404).json({ error: "Task, repository, or draft patch artifact not found" });
      return;
    }
    if (draftArtifact.type !== "draft_patch") {
      res.status(400).json({ error: "Sandbox validation requires a draft patch artifact" });
      return;
    }

    const payload = asRecord(draftArtifact.payload);
    const unifiedDiff = typeof payload.unifiedDiff === "string" ? payload.unifiedDiff : "";
    const sourceApprovalId =
      typeof draftArtifact.approvalId === "number" ? draftArtifact.approvalId : undefined;
    const sourceApproval = sourceApprovalId
      ? await loadOwnedApproval(userId, sourceApprovalId)
      : undefined;
    if (!sourceApproval || sourceApproval.action !== "read_files") {
      res.status(409).json({ error: "Draft patch is missing its approved file-read source" });
      return;
    }

    const sourceRequest = sourceApproval.request as { paths?: string[]; branch?: string };
    const paths = normalizeOraxFileReadPaths(sourceRequest.paths ?? []);
    const branch = sourceRequest.branch || repository.defaultBranch;
    const token = repository.encryptedToken
      ? encryptionService.decrypt(repository.encryptedToken)
      : undefined;
    const readResult = await readGithubRepositoryFiles({
      owner: repository.owner,
      repo: repository.name,
      branch,
      paths,
      token,
      maxFileBytes: ORAX_FILE_READ_LIMITS.maxFileBytes,
      maxTotalBytes: ORAX_FILE_READ_LIMITS.maxTotalBytes,
    });

    const tests = Array.isArray(payload.tests)
      ? payload.tests.filter((item): item is string => typeof item === "string")
      : [];
    const sandbox = runOraxSandboxValidation({
      unifiedDiff,
      files: readResult.files,
      suggestedTests: tests,
    });
    const sandboxPayload = {
      sourceArtifactId: draftArtifact.id,
      sourceApprovalId: sourceApproval.id,
      branch,
      validatedAt: new Date().toISOString(),
      filesRead: readResult.files.map((file) => ({
        path: file.path,
        sha: file.sha,
        size: file.size,
      })),
      skipped: readResult.skipped,
      ...sandbox,
    };

    const [sandboxArtifact] = await db
      .insert(oraxTaskArtifactsTable)
      .values({
        userId,
        repositoryId: repository.id,
        taskId: task.id,
        approvalId: approval.id,
        type: "sandbox_result",
        status: sandbox.applied ? "completed" : "failed",
        title: `Sandbox validation for ${draftArtifact.title}`,
        summary: sandbox.applied
          ? `Sandbox validation passed for ${sandbox.changedFiles.length} file(s).`
          : "Sandbox validation failed.",
        payload: sandboxPayload,
      })
      .returning();

    const [updatedApproval] = await db
      .update(oraxTaskApprovalsTable)
      .set({
        status: sandbox.applied ? "completed" : "failed",
        result: {
          artifactId: sandboxArtifact.id,
          applied: sandbox.applied,
          changedFiles: sandbox.changedFiles,
          errors: sandbox.errors,
        },
        completedAt: new Date(),
      })
      .where(eq(oraxTaskApprovalsTable.id, approval.id))
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        status: sandbox.applied ? "completed" : "blocked",
        result: {
          ...asRecord(task.result),
          sandbox: {
            artifactId: sandboxArtifact.id,
            applied: sandbox.applied,
            changedFiles: sandbox.changedFiles.length,
            errors: sandbox.errors,
          },
          message: sandbox.applied
            ? "ORAX validated the draft patch inside an isolated sandbox. No repository files were changed, no commands were run, and nothing was pushed."
            : "ORAX could not validate the draft patch inside the sandbox.",
        },
        updatedAt: new Date(),
        completedAt: sandbox.applied ? new Date() : null,
      })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "tool",
      event: "sandbox_completed",
      content: sandbox.applied
        ? `Sandbox validation passed for ${sandbox.changedFiles.length} changed file${sandbox.changedFiles.length === 1 ? "" : "s"}.`
        : "Sandbox validation failed.",
      approvalId: updatedApproval.id,
      artifactId: sandboxArtifact.id,
      metadata: {
        applied: sandbox.applied,
        changedFiles: sandbox.changedFiles,
        errors: sandbox.errors,
      },
    });

    res.json({ approval: updatedApproval, artifact: sandboxArtifact });
  } catch (err) {
    logger.error({ component: "orax", err, approvalId }, "Failed to run ORAX sandbox validation");
    res.status(502).json({ error: "Could not run sandbox validation" });
  }
});

router.post("/orax/approvals/:id/run-commands", async (req, res) => {
  const userId = req.userId!;
  const approvalId = Number(req.params.id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    res.status(400).json({ error: "Invalid approval id" });
    return;
  }

  try {
    const approval = await loadOwnedApproval(userId, approvalId);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (approval.action !== "safe_check") {
      res.status(400).json({ error: "Unsupported approval action" });
      return;
    }
    if (approval.status !== "approved") {
      res.status(409).json({ error: "Controlled checks require an approved request" });
      return;
    }

    const task = await loadOwnedTask(userId, approval.taskId);
    const repository = await loadOwnedRepository(userId, approval.repositoryId);
    const request = asRecord(approval.request);
    const sandboxArtifactId =
      typeof request.artifactId === "number" ? request.artifactId : Number(request.artifactId);
    const sandboxArtifact = Number.isInteger(sandboxArtifactId)
      ? await loadOwnedArtifact(userId, sandboxArtifactId)
      : undefined;
    if (!task || !repository || !sandboxArtifact || sandboxArtifact.taskId !== task.id) {
      res.status(404).json({ error: "Task, repository, or sandbox artifact not found" });
      return;
    }
    if (sandboxArtifact.type !== "sandbox_result" || sandboxArtifact.status !== "completed") {
      res.status(409).json({ error: "Controlled checks require a completed sandbox result" });
      return;
    }

    const sandboxPayload = asRecord(sandboxArtifact.payload);
    const draftArtifactId =
      typeof sandboxPayload.sourceArtifactId === "number"
        ? sandboxPayload.sourceArtifactId
        : Number(sandboxPayload.sourceArtifactId);
    const draftArtifact = Number.isInteger(draftArtifactId)
      ? await loadOwnedArtifact(userId, draftArtifactId)
      : undefined;
    if (!draftArtifact || draftArtifact.type !== "draft_patch") {
      res.status(409).json({ error: "Sandbox result is missing its draft patch source" });
      return;
    }

    const draftPayload = asRecord(draftArtifact.payload);
    const unifiedDiff =
      typeof draftPayload.unifiedDiff === "string" ? draftPayload.unifiedDiff : "";
    const sourceApprovalId =
      typeof draftArtifact.approvalId === "number" ? draftArtifact.approvalId : undefined;
    const sourceApproval = sourceApprovalId
      ? await loadOwnedApproval(userId, sourceApprovalId)
      : undefined;
    if (!sourceApproval || sourceApproval.action !== "read_files") {
      res.status(409).json({ error: "Draft patch is missing its approved file-read source" });
      return;
    }

    const sourceRequest = sourceApproval.request as { paths?: string[]; branch?: string };
    const branch = sourceRequest.branch || repository.defaultBranch;
    const paths = normalizeOraxFileReadPaths(sourceRequest.paths ?? []);
    const token = repository.encryptedToken
      ? encryptionService.decrypt(repository.encryptedToken)
      : undefined;
    const readResult = await readGithubRepositoryFiles({
      owner: repository.owner,
      repo: repository.name,
      branch,
      paths,
      token,
      maxFileBytes: ORAX_FILE_READ_LIMITS.maxFileBytes,
      maxTotalBytes: ORAX_FILE_READ_LIMITS.maxTotalBytes,
    });

    const tests = Array.isArray(draftPayload.tests)
      ? draftPayload.tests.filter((item): item is string => typeof item === "string")
      : [];
    const sandbox = buildOraxSandboxPatch({
      unifiedDiff,
      files: readResult.files,
      suggestedTests: tests,
    });
    if (!sandbox.validation.applied || !sandbox.patchedFiles.length) {
      res.status(409).json({ error: "Sandbox patch no longer applies to the current branch" });
      return;
    }

    const requestCommands = Array.isArray(request.commands)
      ? request.commands.filter((item): item is string => typeof item === "string")
      : undefined;
    const commands = normalizeOraxSandboxCommandIds(requestCommands);
    const repositoryArchive = hasOraxWorkspaceCommandIds(commands)
      ? await downloadGithubRepositoryTarball({
          owner: repository.owner,
          repo: repository.name,
          branch,
          token,
        })
      : null;
    const commandResult = await runOraxIsolatedWorkspaceChecks({
      commands,
      patchedFiles: sandbox.patchedFiles,
      staticChecks: sandbox.validation.checks,
      repositoryArchive,
    });
    const commandPayload = {
      sourceArtifactId: sandboxArtifact.id,
      draftArtifactId: draftArtifact.id,
      sourceApprovalId: sourceApproval.id,
      branch,
      executedAt: new Date().toISOString(),
      ...commandResult,
      validation: {
        applied: sandbox.validation.applied,
        changedFiles: sandbox.validation.changedFiles,
        errors: sandbox.validation.errors,
      },
    };

    const [commandArtifact] = await db
      .insert(oraxTaskArtifactsTable)
      .values({
        userId,
        repositoryId: repository.id,
        taskId: task.id,
        approvalId: approval.id,
        type: "command_result",
        status: commandResult.passed ? "completed" : "failed",
        title: `Controlled checks for ${sandboxArtifact.title}`,
        summary: commandResult.summary,
        payload: commandPayload,
      })
      .returning();

    const [updatedApproval] = await db
      .update(oraxTaskApprovalsTable)
      .set({
        status: commandResult.passed ? "completed" : "failed",
        result: {
          artifactId: commandArtifact.id,
          passed: commandResult.passed,
          commands: commandResult.commands.map((command) => ({
            id: command.id,
            status: command.status,
            exitCode: command.exitCode,
          })),
        },
        completedAt: new Date(),
      })
      .where(eq(oraxTaskApprovalsTable.id, approval.id))
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        status: commandResult.passed ? "completed" : "blocked",
        result: {
          ...asRecord(task.result),
          controlledChecks: {
            artifactId: commandArtifact.id,
            passed: commandResult.passed,
            commands: commandResult.commands.length,
          },
          message: commandResult.passed
            ? "ORAX ran approval-gated checks in an isolated temporary workspace. Only fixed command IDs were allowed; no arbitrary shell text, push, or deploy ran."
            : "ORAX approval-gated checks failed.",
        },
        updatedAt: new Date(),
        completedAt: commandResult.passed ? new Date() : null,
      })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "tool",
      event: "checks_completed",
      content: commandResult.passed
        ? `Controlled checks passed: ${commandResult.commands.length} check${commandResult.commands.length === 1 ? "" : "s"} completed.`
        : `Controlled checks failed: ${commandResult.commands.length} check${commandResult.commands.length === 1 ? "" : "s"} completed.`,
      approvalId: updatedApproval.id,
      artifactId: commandArtifact.id,
      metadata: {
        passed: commandResult.passed,
        commands: commandResult.commands.map((command) => ({
          id: command.id,
          status: command.status,
          exitCode: command.exitCode,
        })),
      },
    });

    res.json({ approval: updatedApproval, artifact: commandArtifact });
  } catch (err) {
    logger.error({ component: "orax", err, approvalId }, "Failed to run ORAX controlled checks");
    res.status(502).json({ error: "Could not run controlled checks" });
  }
});

router.post("/orax/approvals/:id/create-github-pr", async (req, res) => {
  const userId = req.userId!;
  const approvalId = Number(req.params.id);
  if (!Number.isInteger(approvalId) || approvalId <= 0) {
    res.status(400).json({ error: "Invalid approval id" });
    return;
  }

  try {
    const approval = await loadOwnedApproval(userId, approvalId);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    if (approval.action !== "github_pr") {
      res.status(400).json({ error: "Unsupported approval action" });
      return;
    }
    if (approval.status === "completed") {
      const existingArtifact = await findCompletedGithubPrArtifactForApproval(userId, approval.id);
      if (existingArtifact) {
        res.json({ approval, artifact: existingArtifact, reused: true });
        return;
      }
      res.status(409).json({ error: "GitHub PR approval is already completed" });
      return;
    }
    if (approval.status !== "approved") {
      res.status(409).json({ error: "GitHub PR creation requires an approved request" });
      return;
    }

    const task = await loadOwnedTask(userId, approval.taskId);
    const repository = await loadOwnedRepository(userId, approval.repositoryId);
    const request = asRecord(approval.request);
    const commandArtifactId =
      typeof request.artifactId === "number" ? request.artifactId : Number(request.artifactId);
    const commandArtifact = Number.isInteger(commandArtifactId)
      ? await loadOwnedArtifact(userId, commandArtifactId)
      : undefined;
    if (!task || !repository || !commandArtifact || commandArtifact.taskId !== task.id) {
      res.status(404).json({ error: "Task, repository, or controlled-check artifact not found" });
      return;
    }
    if (repository.provider !== "github") {
      res.status(400).json({ error: "GitHub PR creation only supports GitHub repositories" });
      return;
    }
    if (!repository.encryptedToken) {
      res.status(409).json({ error: "Connect a GitHub token before creating a pull request" });
      return;
    }
    if (commandArtifact.type !== "command_result" || commandArtifact.status !== "completed") {
      res.status(409).json({ error: "GitHub PR creation requires completed controlled checks" });
      return;
    }

    const commandPayload = asRecord(commandArtifact.payload);
    if (commandPayload.passed !== true) {
      res.status(409).json({ error: "GitHub PR creation requires passed controlled checks" });
      return;
    }

    const existingArtifact = await findCompletedGithubPrArtifactForCommand(
      userId,
      task.id,
      commandArtifact.id,
    );
    if (existingArtifact) {
      const existingPayload = asRecord(existingArtifact.payload);
      const [updatedApproval] = await db
        .update(oraxTaskApprovalsTable)
        .set({
          status: "completed",
          result: buildGithubPrApprovalResult(existingArtifact.id, existingPayload),
          completedAt: new Date(),
        })
        .where(eq(oraxTaskApprovalsTable.id, approval.id))
        .returning();

      await db
        .update(oraxTasksTable)
        .set({
          status: "completed",
          result: {
            ...asRecord(task.result),
            githubPr: buildGithubPrTaskResult(existingArtifact.id, existingPayload),
            message:
              "ORAX reused the existing GitHub pull request for this checked patch. No duplicate PR was created.",
          },
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(oraxTasksTable.id, task.id));

      await persistOraxTimelineMessage({
        userId,
        task,
        role: "tool",
        event: "pr_reused",
        content: `Existing GitHub PR reused for artifact #${existingArtifact.id}.`,
        approvalId: updatedApproval.id,
        artifactId: existingArtifact.id,
        metadata: {
          reused: true,
          payload: existingPayload,
        },
      });

      res.json({ approval: updatedApproval, artifact: existingArtifact, reused: true });
      return;
    }
    const sourceSandboxArtifactId =
      typeof commandPayload.sourceArtifactId === "number"
        ? commandPayload.sourceArtifactId
        : Number(commandPayload.sourceArtifactId);
    const sandboxArtifact = Number.isInteger(sourceSandboxArtifactId)
      ? await loadOwnedArtifact(userId, sourceSandboxArtifactId)
      : undefined;
    if (!sandboxArtifact || sandboxArtifact.type !== "sandbox_result") {
      res.status(409).json({ error: "Controlled-check result is missing its sandbox source" });
      return;
    }
    const draftArtifactId =
      typeof commandPayload.draftArtifactId === "number"
        ? commandPayload.draftArtifactId
        : Number(commandPayload.draftArtifactId);
    const draftArtifact = Number.isInteger(draftArtifactId)
      ? await loadOwnedArtifact(userId, draftArtifactId)
      : undefined;
    if (!draftArtifact || draftArtifact.type !== "draft_patch") {
      res.status(409).json({ error: "Sandbox result is missing its draft patch source" });
      return;
    }

    const draftPayload = asRecord(draftArtifact.payload);
    const unifiedDiff =
      typeof draftPayload.unifiedDiff === "string" ? draftPayload.unifiedDiff : "";
    const sourceApprovalId =
      typeof draftArtifact.approvalId === "number" ? draftArtifact.approvalId : undefined;
    const sourceApproval = sourceApprovalId
      ? await loadOwnedApproval(userId, sourceApprovalId)
      : undefined;
    if (!sourceApproval || sourceApproval.action !== "read_files") {
      res.status(409).json({ error: "Draft patch is missing its approved file-read source" });
      return;
    }

    const sourceRequest = sourceApproval.request as { paths?: string[]; branch?: string };
    const branch = sourceRequest.branch || repository.defaultBranch;
    const paths = normalizeOraxFileReadPaths(sourceRequest.paths ?? []);
    const token = encryptionService.decrypt(repository.encryptedToken);
    const readResult = await readGithubRepositoryFiles({
      owner: repository.owner,
      repo: repository.name,
      branch,
      paths,
      token,
      maxFileBytes: ORAX_FILE_READ_LIMITS.maxFileBytes,
      maxTotalBytes: ORAX_FILE_READ_LIMITS.maxTotalBytes,
    });

    const tests = Array.isArray(draftPayload.tests)
      ? draftPayload.tests.filter((item): item is string => typeof item === "string")
      : [];
    const sandbox = buildOraxSandboxPatch({
      unifiedDiff,
      files: readResult.files,
      suggestedTests: tests,
    });
    const branchName = buildOraxBranchName(task.id, commandArtifact.id);
    if (!sandbox.validation.applied || !sandbox.patchedFiles.length) {
      const failure = normalizeGithubPrFailure(
        new Error("Sandbox patch no longer applies to the current branch"),
      );
      const failed = await persistGithubPrFailure({
        userId,
        task,
        approval,
        sandboxArtifact,
        commandArtifact,
        draftArtifact,
        sourceApproval,
        branchName,
        baseBranch: branch,
        changedFiles: sandbox.validation.changedFiles.map((file) => file.path),
        validation: sandbox.validation,
        failure,
      });
      res.status(409).json({
        approval: failed.approval,
        artifact: failed.artifact,
        error: failure.message,
      });
      return;
    }

    const title =
      typeof request.title === "string" && request.title.trim()
        ? request.title.trim()
        : `ORAX: ${task.title}`;
    let pullRequest;
    try {
      pullRequest = await createGithubPullRequestFromFiles({
        owner: repository.owner,
        repo: repository.name,
        token,
        baseBranch: branch,
        branchName,
        title,
        commitMessage: title,
        body: buildPullRequestBody({
          task,
          readApprovalId: sourceApproval.id,
          githubApprovalId: approval.id,
          sandboxArtifactId: sandboxArtifact.id,
          commandArtifactId: commandArtifact.id,
          draftArtifactId: draftArtifact.id,
          customBody: typeof request.body === "string" ? request.body : null,
          validation: sandbox.validation,
          commandResult: commandPayload,
        }),
        files: sandbox.patchedFiles.map((file) => ({
          path: file.path,
          content: file.content,
        })),
      });
    } catch (err) {
      const afterErrorExisting = await findCompletedGithubPrArtifactForCommand(
        userId,
        task.id,
        commandArtifact.id,
      );
      if (afterErrorExisting) {
        const existingPayload = asRecord(afterErrorExisting.payload);
        const [updatedApproval] = await db
          .update(oraxTaskApprovalsTable)
          .set({
            status: "completed",
            result: buildGithubPrApprovalResult(afterErrorExisting.id, existingPayload),
            completedAt: new Date(),
          })
          .where(eq(oraxTaskApprovalsTable.id, approval.id))
          .returning();

        await persistOraxTimelineMessage({
          userId,
          task,
          role: "tool",
          event: "pr_reused",
          content: `Existing GitHub PR reused for artifact #${afterErrorExisting.id}.`,
          approvalId: updatedApproval.id,
          artifactId: afterErrorExisting.id,
          metadata: {
            reused: true,
            payload: existingPayload,
          },
        });

        res.json({ approval: updatedApproval, artifact: afterErrorExisting, reused: true });
        return;
      }

      const failure = normalizeGithubPrFailure(err);
      const failed = await persistGithubPrFailure({
        userId,
        task,
        approval,
        sandboxArtifact,
        commandArtifact,
        draftArtifact,
        sourceApproval,
        branchName,
        baseBranch: branch,
        changedFiles: sandbox.patchedFiles.map((file) => file.path),
        validation: sandbox.validation,
        failure,
      });
      res.status(failure.statusCode).json({
        approval: failed.approval,
        artifact: failed.artifact,
        error: failure.message,
      });
      return;
    }

    const prPayload = {
      sourceArtifactId: sandboxArtifact.id,
      commandArtifactId: commandArtifact.id,
      draftArtifactId: draftArtifact.id,
      branchName: pullRequest.branchName,
      baseBranch: pullRequest.baseBranch,
      commitSha: pullRequest.commitSha,
      pullRequestNumber: pullRequest.pullRequestNumber,
      pullRequestUrl: pullRequest.pullRequestUrl,
      pullRequestState: pullRequest.pullRequestState,
      filesChanged: pullRequest.changedFiles,
      createdAt: new Date().toISOString(),
      validation: {
        applied: sandbox.validation.applied,
        changedFiles: sandbox.validation.changedFiles,
        errors: sandbox.validation.errors,
      },
      auditTrail: buildOraxAuditTrail({
        readApprovalId: sourceApproval.id,
        draftArtifactId: draftArtifact.id,
        sandboxArtifactId: sandboxArtifact.id,
        commandArtifactId: commandArtifact.id,
        githubApprovalId: approval.id,
      }),
    };

    const [prArtifact] = await db
      .insert(oraxTaskArtifactsTable)
      .values({
        userId,
        repositoryId: repository.id,
        taskId: task.id,
        approvalId: approval.id,
        type: "github_pr_result",
        status: "completed",
        title: `GitHub PR for ${task.title}`,
        summary: `Opened PR #${pullRequest.pullRequestNumber} on ${pullRequest.branchName}.`,
        payload: prPayload,
      })
      .returning();

    const [updatedApproval] = await db
      .update(oraxTaskApprovalsTable)
      .set({
        status: "completed",
        result: {
          ...buildGithubPrApprovalResult(prArtifact.id, prPayload),
        },
        completedAt: new Date(),
      })
      .where(eq(oraxTaskApprovalsTable.id, approval.id))
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        status: "completed",
        result: {
          ...asRecord(task.result),
          githubPr: buildGithubPrTaskResult(prArtifact.id, prPayload),
          message:
            "ORAX created a GitHub branch and pull request from the controlled-check-passed patch. The default branch was not modified directly.",
        },
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(oraxTasksTable.id, task.id));

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "tool",
      event: "pr_created",
      content: `GitHub PR #${pullRequest.pullRequestNumber} created on branch ${pullRequest.branchName}.`,
      approvalId: updatedApproval.id,
      artifactId: prArtifact.id,
      metadata: {
        pullRequestNumber: pullRequest.pullRequestNumber,
        pullRequestUrl: pullRequest.pullRequestUrl,
        branchName: pullRequest.branchName,
        filesChanged: pullRequest.changedFiles,
      },
    });

    res.json({ approval: updatedApproval, artifact: prArtifact });
  } catch (err) {
    logger.error({ component: "orax", err, approvalId }, "Failed to create ORAX GitHub PR");
    res.status(502).json({ error: "Could not create GitHub pull request" });
  }
});

router.post("/orax/tasks", async (req, res) => {
  const userId = req.userId!;
  const parsed = createTaskSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ORAX task" });
    return;
  }

  try {
    const [repository] = await db
      .select()
      .from(oraxRepositoriesTable)
      .where(
        and(
          eq(oraxRepositoriesTable.id, parsed.data.repositoryId),
          eq(oraxRepositoriesTable.userId, userId),
          isNull(oraxRepositoriesTable.archivedAt),
        ),
      );

    if (!repository) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const plan = buildOraxTaskPlan({
      kind: parsed.data.kind,
      repository,
      prompt: parsed.data.prompt,
    });

    const [task] = await db
      .insert(oraxTasksTable)
      .values({
        userId,
        repositoryId: repository.id,
        kind: parsed.data.kind,
        status: "planned",
        title: parsed.data.title ?? titleFromPrompt(parsed.data.prompt),
        prompt: parsed.data.prompt,
        plan,
        result: {
          message:
            "ORAX Phase 1 created a safe coding-agent plan. File writes, terminal execution, and Git pushes are locked until the approval-gated execution layer is implemented.",
        },
        approvalRequired: "write_and_push",
      })
      .returning();

    await persistOraxTimelineMessage({
      userId,
      task,
      role: "system",
      event: "task_created",
      content: `ORAX task created: ${task.title}`,
      metadata: {
        kind: task.kind,
        repositoryId: repository.id,
        repository: `${repository.owner}/${repository.name}`,
      },
    });

    res.status(201).json({ task });
  } catch (err) {
    logger.error({ component: "orax", err }, "Failed to create ORAX task");
    res.status(500).json({ error: "Failed to create ORAX task" });
  }
});

function titleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
}

function toRepositorySummary(repository: OraxRepository) {
  const {
    encryptedToken: _encryptedToken,
    userId: _userId,
    archivedAt: _archivedAt,
    ...safeRepository
  } = repository;
  return safeRepository;
}

type OraxGithubPrFailure = {
  code: string;
  message: string;
  hint: string;
  statusCode: number;
  rawMessage: string;
};

type OraxPrValidation = {
  applied: boolean;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  errors: string[];
};

function buildOraxBranchName(taskId: number, commandArtifactId: number): string {
  return `orax/task-${taskId}-check-${commandArtifactId}`;
}

async function findCompletedGithubPrArtifactForApproval(userId: string, approvalId: number) {
  const [artifact] = await db
    .select()
    .from(oraxTaskArtifactsTable)
    .where(
      and(
        eq(oraxTaskArtifactsTable.userId, userId),
        eq(oraxTaskArtifactsTable.approvalId, approvalId),
        eq(oraxTaskArtifactsTable.type, "github_pr_result"),
        eq(oraxTaskArtifactsTable.status, "completed"),
        isNull(oraxTaskArtifactsTable.archivedAt),
      ),
    )
    .orderBy(desc(oraxTaskArtifactsTable.createdAt))
    .limit(1);
  return artifact;
}

async function findCompletedGithubPrArtifactForCommand(
  userId: string,
  taskId: number,
  commandArtifactId: number,
) {
  const artifacts = await db
    .select()
    .from(oraxTaskArtifactsTable)
    .where(
      and(
        eq(oraxTaskArtifactsTable.userId, userId),
        eq(oraxTaskArtifactsTable.taskId, taskId),
        eq(oraxTaskArtifactsTable.type, "github_pr_result"),
        eq(oraxTaskArtifactsTable.status, "completed"),
        isNull(oraxTaskArtifactsTable.archivedAt),
      ),
    )
    .orderBy(desc(oraxTaskArtifactsTable.createdAt))
    .limit(25);

  return artifacts.find((artifact) => {
    const payload = asRecord(artifact.payload);
    const value =
      typeof payload.commandArtifactId === "number"
        ? payload.commandArtifactId
        : Number(payload.commandArtifactId);
    return value === commandArtifactId;
  });
}

async function persistGithubPrFailure(input: {
  userId: string;
  task: OraxTask;
  approval: OraxTaskApproval;
  sandboxArtifact: OraxTaskArtifact;
  commandArtifact: OraxTaskArtifact;
  draftArtifact: OraxTaskArtifact;
  sourceApproval: OraxTaskApproval;
  branchName: string;
  baseBranch: string;
  changedFiles: string[];
  validation: OraxPrValidation;
  failure: OraxGithubPrFailure;
}) {
  const failedAt = new Date();
  const payload = {
    sourceArtifactId: input.sandboxArtifact.id,
    commandArtifactId: input.commandArtifact.id,
    draftArtifactId: input.draftArtifact.id,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    filesChanged: input.changedFiles,
    failedAt: failedAt.toISOString(),
    error: input.failure,
    validation: input.validation,
    auditTrail: buildOraxAuditTrail({
      readApprovalId: input.sourceApproval.id,
      draftArtifactId: input.draftArtifact.id,
      sandboxArtifactId: input.sandboxArtifact.id,
      commandArtifactId: input.commandArtifact.id,
      githubApprovalId: input.approval.id,
    }),
  };

  const [artifact] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: input.task.repositoryId,
      taskId: input.task.id,
      approvalId: input.approval.id,
      type: "github_pr_result",
      status: "failed",
      title: `GitHub PR failed for ${input.task.title}`,
      summary: input.failure.message,
      payload,
    })
    .returning();

  const [approval] = await db
    .update(oraxTaskApprovalsTable)
    .set({
      status: "failed",
      result: {
        artifactId: artifact.id,
        branchName: input.branchName,
        error: input.failure,
      },
      completedAt: failedAt,
    })
    .where(eq(oraxTaskApprovalsTable.id, input.approval.id))
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      status: "blocked",
      result: {
        ...asRecord(input.task.result),
        githubPrFailure: {
          artifactId: artifact.id,
          branchName: input.branchName,
          error: input.failure,
        },
        message: input.failure.message,
      },
      updatedAt: failedAt,
      completedAt: null,
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  await persistOraxTimelineMessage({
    userId: input.userId,
    task: input.task,
    role: "tool",
    event: "pr_failed",
    content: `GitHub PR creation failed: ${input.failure.message}`,
    approvalId: approval.id,
    artifactId: artifact.id,
    metadata: {
      branchName: input.branchName,
      error: input.failure,
      changedFiles: input.changedFiles,
    },
  });

  return { approval, artifact };
}

function normalizeGithubPrFailure(err: unknown): OraxGithubPrFailure {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const lower = rawMessage.toLowerCase();

  if (lower.includes("sandbox patch no longer applies")) {
    return {
      code: "patch_no_longer_applies",
      message: "The checked patch no longer applies to the current branch.",
      hint: "Regenerate the draft patch from the latest approved file read, then rerun checks.",
      statusCode: 409,
      rawMessage,
    };
  }
  if (
    lower.includes("bad credentials") ||
    lower.includes("resource not accessible") ||
    lower.includes("requires authentication") ||
    lower.includes("not authorized") ||
    lower.includes("http 401") ||
    lower.includes("http 403")
  ) {
    return {
      code: "github_permission_error",
      message: "GitHub rejected PR creation because the token does not have enough permission.",
      hint: "Reconnect GitHub with a token that can create branches, commits, and pull requests for this repository.",
      statusCode: 403,
      rawMessage,
    };
  }
  if (lower.includes("reference already exists") || lower.includes("already_exists")) {
    return {
      code: "github_branch_exists",
      message: "GitHub already has the ORAX branch for this checked patch.",
      hint: "Refresh ORAX. If a PR already exists, ORAX will reuse it; otherwise delete the stale ORAX branch or create a new checked patch.",
      statusCode: 409,
      rawMessage,
    };
  }
  if (lower.includes("validation failed")) {
    return {
      code: "github_validation_failed",
      message: "GitHub rejected the branch or pull request payload.",
      hint: "Review the failed artifact details, then retry after correcting the repository state or PR title/body.",
      statusCode: 409,
      rawMessage,
    };
  }
  if (lower.includes("not found") || lower.includes("http 404")) {
    return {
      code: "github_repository_not_found",
      message: "GitHub could not find the repository, branch, or required object.",
      hint: "Confirm the repository connection, default branch, and token access, then retry.",
      statusCode: 404,
      rawMessage,
    };
  }

  return {
    code: "github_api_error",
    message: "GitHub PR creation failed.",
    hint: "Review the raw GitHub error in the failed artifact, then retry after the repository or token issue is fixed.",
    statusCode: 502,
    rawMessage,
  };
}

function buildGithubPrApprovalResult(
  artifactId: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    artifactId,
    branchName: payload.branchName,
    commitSha: payload.commitSha,
    pullRequestNumber: payload.pullRequestNumber,
    pullRequestUrl: payload.pullRequestUrl,
  };
}

function buildGithubPrTaskResult(
  artifactId: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return buildGithubPrApprovalResult(artifactId, payload);
}

function buildPullRequestBody(input: {
  task: OraxTask;
  readApprovalId: number;
  githubApprovalId: number;
  sandboxArtifactId: number;
  commandArtifactId: number;
  draftArtifactId: number;
  customBody?: string | null;
  validation: {
    changedFiles: Array<{ path: string; additions: number; deletions: number }>;
    testPreview: Array<{ name: string; status: string; message: string }>;
  };
  commandResult: Record<string, unknown>;
}): string {
  const changedFiles = input.validation.changedFiles
    .map((file) => `- ${file.path} (+${file.additions} / -${file.deletions})`)
    .join("\n");
  const commandResult = input.commandResult;
  const commands = Array.isArray(commandResult.commands)
    ? commandResult.commands
        .map((command) => {
          const record = asRecord(command);
          const id = typeof record.id === "string" ? record.id : "unknown";
          const status = typeof record.status === "string" ? record.status : "unknown";
          const message = typeof record.message === "string" ? record.message : "";
          return `- ${id}: ${status}${message ? ` - ${message}` : ""}`;
        })
        .join("\n")
    : "";
  const checks = commands || "- No controlled checks were recorded.";

  return [
    input.customBody?.trim() || `ORAX generated this PR from task #${input.task.id}.`,
    "",
    "## ORAX Safety Record",
    `- Read approval: #${input.readApprovalId}`,
    `- Draft artifact: #${input.draftArtifactId}`,
    `- Sandbox artifact: #${input.sandboxArtifactId}`,
    `- Controlled-check artifact: #${input.commandArtifactId}`,
    `- GitHub PR approval: #${input.githubApprovalId}`,
    "- Default branch was not modified directly.",
    "- No unrestricted terminal commands were executed by ORAX.",
    "- Package checks, when present, were limited to approved ORAX command IDs in a temporary workspace.",
    "- No deployment was triggered.",
    "",
    "## Changed Files",
    changedFiles || "- None recorded.",
    "",
    "## Checks",
    checks,
  ].join("\n");
}

function buildOraxAuditTrail(input: {
  readApprovalId: number;
  draftArtifactId: number;
  sandboxArtifactId: number;
  commandArtifactId: number;
  githubApprovalId: number;
}) {
  return [
    { label: "Read approval", id: input.readApprovalId, kind: "approval" },
    { label: "Draft patch", id: input.draftArtifactId, kind: "artifact" },
    { label: "Sandbox validation", id: input.sandboxArtifactId, kind: "artifact" },
    { label: "Workspace checks", id: input.commandArtifactId, kind: "artifact" },
    { label: "GitHub PR approval", id: input.githubApprovalId, kind: "approval" },
  ];
}

async function persistOraxTimelineMessage(input: OraxTimelineMessageInput): Promise<void> {
  let timelineSaved = false;
  try {
    await db.insert(oraxTaskMessagesTable).values({
      userId: input.userId,
      repositoryId: input.task.repositoryId,
      taskId: input.task.id,
      role: input.role ?? "system",
      content: input.content,
      approvalId: input.approvalId ?? null,
      artifactId: input.artifactId ?? null,
      metadata: {
        source: "orax-task-timeline",
        event: input.event,
        ...(input.metadata ?? {}),
      },
    });
    timelineSaved = true;
  } catch (err) {
    logger.warn(
      { component: "orax", err, taskId: input.task.id, event: input.event },
      "Failed to persist ORAX timeline message",
    );
  }

  if (timelineSaved) {
    await persistOraxCheckpoint({
      userId: input.userId,
      taskId: input.task.id,
    });
  }
}

async function persistOraxCheckpoint(input: { userId: string; taskId: number }): Promise<void> {
  try {
    const task = await loadOwnedTask(input.userId, input.taskId);
    if (!task) return;

    const [approvals, artifacts] = await Promise.all([
      db
        .select()
        .from(oraxTaskApprovalsTable)
        .where(
          and(
            eq(oraxTaskApprovalsTable.userId, input.userId),
            eq(oraxTaskApprovalsTable.taskId, input.taskId),
          ),
        )
        .orderBy(desc(oraxTaskApprovalsTable.createdAt)),
      db
        .select()
        .from(oraxTaskArtifactsTable)
        .where(
          and(
            eq(oraxTaskArtifactsTable.userId, input.userId),
            eq(oraxTaskArtifactsTable.taskId, input.taskId),
            isNull(oraxTaskArtifactsTable.archivedAt),
          ),
        )
        .orderBy(desc(oraxTaskArtifactsTable.createdAt)),
    ]);

    const checkpoint = buildOraxCheckpointSummary({ task, approvals, artifacts });
    const result = asRecord(task.result);

    await db
      .update(oraxTasksTable)
      .set({
        result: {
          ...result,
          currentCheckpoint: checkpoint,
        },
        updatedAt: new Date(),
      })
      .where(eq(oraxTasksTable.id, task.id));

    await db.insert(oraxTaskMessagesTable).values({
      userId: input.userId,
      repositoryId: task.repositoryId,
      taskId: task.id,
      role: "system",
      content: `Checkpoint updated: ${checkpoint.nextStep}`,
      metadata: {
        source: "orax-task-checkpoint",
        event: "checkpoint_updated",
        checkpoint,
      },
    });
  } catch (err) {
    logger.warn(
      { component: "orax", err, taskId: input.taskId },
      "Failed to persist ORAX checkpoint",
    );
  }
}

function buildOraxCheckpointSummary(input: {
  task: OraxTask;
  approvals: OraxTaskApproval[];
  artifacts: OraxTaskArtifact[];
}): OraxCheckpointSummary {
  const approvals = {
    pending: input.approvals.filter((approval) => approval.status === "pending").length,
    completed: input.approvals.filter((approval) => approval.status === "completed").length,
    failed: input.approvals.filter((approval) => approval.status === "failed").length,
    denied: input.approvals.filter((approval) => approval.status === "denied").length,
    total: input.approvals.length,
  };
  const artifacts = {
    draftPatches: input.artifacts.filter((artifact) => artifact.type === "draft_patch").length,
    sandboxResults: input.artifacts.filter((artifact) => artifact.type === "sandbox_result").length,
    commandResults: input.artifacts.filter((artifact) => artifact.type === "command_result").length,
    githubPrResults: input.artifacts.filter((artifact) => artifact.type === "github_pr_result")
      .length,
    total: input.artifacts.length,
  };
  const latestFailedArtifact = input.artifacts.find((artifact) => artifact.status === "failed");
  const latestDeniedApproval = input.approvals.find((approval) => approval.status === "denied");
  const taskResult = asRecord(input.task.result);
  const plan = asRecord(input.task.plan);
  const latestBlocker =
    blockerFromArtifact(latestFailedArtifact) ??
    (latestDeniedApproval
      ? `Approval #${latestDeniedApproval.id} was denied.`
      : typeof taskResult.message === "string" &&
          (input.task.status === "blocked" || input.task.status === "failed")
        ? taskResult.message
        : null);

  return {
    goal:
      typeof plan.objective === "string" && plan.objective.trim()
        ? plan.objective.trim()
        : input.task.prompt,
    status: input.task.status,
    filesReviewed: collectOraxCheckpointFiles(input.approvals, input.artifacts),
    approvals,
    artifacts,
    latestBlocker,
    nextStep: buildOraxCheckpointNextStep({
      approvals,
      artifacts,
      hasBlocker: Boolean(latestBlocker),
      hasCompletedReadApproval: input.approvals.some(
        (approval) => approval.action === "read_files" && approval.status === "completed",
      ),
      hasCompletedPr: input.artifacts.some(
        (artifact) => artifact.type === "github_pr_result" && artifact.status === "completed",
      ),
    }),
    updatedAt: new Date().toISOString(),
  };
}

function collectOraxCheckpointFiles(
  approvals: OraxTaskApproval[],
  artifacts: OraxTaskArtifact[],
): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !value.startsWith("http")) {
      paths.add(value.trim());
    }
  };

  for (const approval of approvals) {
    const request = asRecord(approval.request);
    const result = asRecord(approval.result);
    if (Array.isArray(request.paths)) request.paths.forEach(add);
    if (Array.isArray(result.files)) {
      for (const file of result.files) add(asRecord(file).path);
    }
  }

  for (const artifact of artifacts) {
    const payload = asRecord(artifact.payload);
    if (Array.isArray(payload.filesRead)) {
      for (const file of payload.filesRead) add(asRecord(file).path);
    }
    if (Array.isArray(payload.changedFiles)) {
      for (const file of payload.changedFiles) add(asRecord(file).path);
    }
    if (Array.isArray(payload.filesChanged)) payload.filesChanged.forEach(add);
  }

  return Array.from(paths).slice(0, 12);
}

function blockerFromArtifact(artifact: OraxTaskArtifact | undefined): string | null {
  if (!artifact) return null;
  const payload = asRecord(artifact.payload);
  const error = asRecord(payload.error);
  if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof artifact.summary === "string" && artifact.summary.trim()) return artifact.summary;
  return `${artifact.title} failed.`;
}

function buildOraxCheckpointNextStep(input: {
  approvals: OraxCheckpointSummary["approvals"];
  artifacts: OraxCheckpointSummary["artifacts"];
  hasBlocker: boolean;
  hasCompletedReadApproval: boolean;
  hasCompletedPr: boolean;
}): string {
  if (input.hasBlocker) {
    return "Resolve the latest blocker before requesting another approval.";
  }
  if (input.approvals.pending > 0) {
    return `Review ${input.approvals.pending} pending approval${
      input.approvals.pending === 1 ? "" : "s"
    }.`;
  }
  if (input.hasCompletedPr) {
    return "Review the created pull request and keep the task thread updated.";
  }
  if (input.artifacts.commandResults > 0) {
    return "If controlled checks passed, request GitHub PR approval with CREATE PR.";
  }
  if (input.artifacts.sandboxResults > 0) {
    return "Request controlled workspace checks for the sandbox-validated patch.";
  }
  if (input.artifacts.draftPatches > 0) {
    return "Request sandbox validation for the draft patch.";
  }
  if (input.hasCompletedReadApproval) {
    return "Generate a draft patch preview from the approved file read.";
  }
  return "Request approval to read the relevant repository files.";
}

function buildOraxTaskThreadReply(input: {
  task: OraxTask;
  approvals: OraxTaskApproval[];
  artifacts: OraxTaskArtifact[];
  actionSuggestions: OraxTaskActionSuggestion[];
}): string {
  const pendingApprovals = input.approvals.filter((approval) => approval.status === "pending");
  const completedArtifacts = input.artifacts.filter((artifact) => artifact.status === "completed");
  const latestArtifact = input.artifacts[0];
  const suggestionLine = input.actionSuggestions.length
    ? `Suggested next action: ${input.actionSuggestions[0].title}.`
    : "Suggested next action: clarify the target files or behavior before requesting approval.";
  const nextStep =
    pendingApprovals.length > 0
      ? `There ${pendingApprovals.length === 1 ? "is" : "are"} ${pendingApprovals.length} pending approval${
          pendingApprovals.length === 1 ? "" : "s"
        }. Review the approval card before ORAX continues.`
      : latestArtifact
        ? `The latest artifact is "${latestArtifact.title}" with status "${latestArtifact.status}". Review the artifact panel for the next available action.`
        : "No execution artifact exists yet. Start with a read-files approval or draft-patch request when you are ready.";

  return [
    `I saved this in the ORAX task thread for "${input.task.title}".`,
    `Current task status: ${input.task.status}.`,
    `Approvals: ${input.approvals.length}. Artifacts: ${input.artifacts.length}. Completed artifacts: ${completedArtifacts.length}.`,
    suggestionLine,
    nextStep,
    "Phase 4B is planning-only: this chat can suggest approval-ready next steps, but it cannot run commands, edit files, push branches, or open PRs without the existing approval controls.",
  ].join("\n");
}

function buildOraxTaskActionSuggestions(input: {
  task: OraxTask;
  approvals: OraxTaskApproval[];
  artifacts: OraxTaskArtifact[];
  userMessage: string;
}): OraxTaskActionSuggestion[] {
  const suggestions: OraxTaskActionSuggestion[] = [];
  const pendingApproval = input.approvals.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    suggestions.push({
      type: "review_pending_approval",
      title: "Review pending approval",
      description:
        "This task already has a pending approval. Decide that approval before requesting another workflow step.",
      approvalId: pendingApproval.id,
    });
    return suggestions;
  }

  const latestCommandResult = input.artifacts.find(
    (artifact) => artifact.type === "command_result",
  );
  const latestCommandPayload = asRecord(latestCommandResult?.payload);
  if (latestCommandResult?.status === "completed" && latestCommandPayload.passed === true) {
    suggestions.push({
      type: "github_pr",
      title: "Prepare PR approval",
      description:
        "Controlled checks passed. Review the PR section and type CREATE PR manually if you want ORAX to request PR creation approval.",
      buttonLabel: "Prepare PR approval",
      artifactId: latestCommandResult.id,
      requiresManualConfirmation: true,
    });
  }

  const latestSandboxResult = input.artifacts.find(
    (artifact) => artifact.type === "sandbox_result",
  );
  const latestSandboxPayload = asRecord(latestSandboxResult?.payload);
  if (latestSandboxResult && latestSandboxPayload.applied === true) {
    suggestions.push({
      type: "controlled_checks",
      title: "Prepare controlled checks",
      description:
        "The draft patch applied in the sandbox. Select the allowlisted checks you want to request next.",
      buttonLabel: "Use default checks",
      artifactId: latestSandboxResult.id,
      commands: [...ORAX_SANDBOX_COMMAND_IDS],
    });
  }

  const latestDraftPatch = input.artifacts.find((artifact) => artifact.type === "draft_patch");
  if (latestDraftPatch && latestDraftPatch.status !== "rejected") {
    suggestions.push({
      type: "sandbox_run",
      title: "Request sandbox validation",
      description:
        "A draft patch exists. Use the existing sandbox approval button when you are ready to validate it.",
      buttonLabel: "Prepare sandbox approval",
      artifactId: latestDraftPatch.id,
    });
  }

  const completedReadApproval = input.approvals.find(
    (approval) => approval.action === "read_files" && approval.status === "completed",
  );
  if (completedReadApproval) {
    suggestions.push({
      type: "draft_patch",
      title: "Prepare draft patch instructions",
      description:
        "Approved files have been read. Use this message as draft-patch guidance, then generate a preview from the completed read approval.",
      buttonLabel: "Use as draft instructions",
      approvalId: completedReadApproval.id,
      instructions: input.userMessage.slice(0, 2000),
    });
  }

  const extractedPaths = extractOraxCandidatePaths(input.userMessage);
  if (extractedPaths.length > 0 || suggestions.length === 0) {
    suggestions.push({
      type: "read_files",
      title: "Prepare file-read approval",
      description:
        extractedPaths.length > 0
          ? "I found likely file paths in your message. Use them to prepare a read-files approval request."
          : "Start by identifying the source files ORAX should read before planning a code change.",
      buttonLabel: extractedPaths.length > 0 ? "Use detected paths" : undefined,
      paths: extractedPaths,
      reason: `Task discussion: ${input.task.title}`.slice(0, 1000),
    });
  }

  return suggestions.slice(0, 4);
}

function extractOraxCandidatePaths(message: string): string[] {
  const matches =
    message.match(
      /\b(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|\b(?:package\.json|pnpm-lock\.yaml|README\.md|tsconfig\.json|vite\.config\.ts)\b/g,
    ) ?? [];
  return Array.from(new Set(matches))
    .filter((pathName) => !pathName.startsWith("http"))
    .slice(0, ORAX_FILE_READ_LIMITS.maxFiles);
}

async function loadOwnedRepository(userId: string, repositoryId: number) {
  const [repository] = await db
    .select()
    .from(oraxRepositoriesTable)
    .where(
      and(
        eq(oraxRepositoriesTable.id, repositoryId),
        eq(oraxRepositoriesTable.userId, userId),
        isNull(oraxRepositoriesTable.archivedAt),
      ),
    );
  return repository;
}

async function loadOwnedTask(userId: string, taskId: number): Promise<OraxTask | undefined> {
  const [task] = await db
    .select()
    .from(oraxTasksTable)
    .where(
      and(
        eq(oraxTasksTable.id, taskId),
        eq(oraxTasksTable.userId, userId),
        isNull(oraxTasksTable.archivedAt),
      ),
    );
  return task;
}

async function loadOwnedApproval(
  userId: string,
  approvalId: number,
): Promise<OraxTaskApproval | undefined> {
  const [approval] = await db
    .select()
    .from(oraxTaskApprovalsTable)
    .where(
      and(eq(oraxTaskApprovalsTable.id, approvalId), eq(oraxTaskApprovalsTable.userId, userId)),
    );
  return approval;
}

async function loadOwnedArtifact(userId: string, artifactId: number) {
  const [artifact] = await db
    .select()
    .from(oraxTaskArtifactsTable)
    .where(
      and(
        eq(oraxTaskArtifactsTable.id, artifactId),
        eq(oraxTaskArtifactsTable.userId, userId),
        isNull(oraxTaskArtifactsTable.archivedAt),
      ),
    );
  return artifact;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export default router;
