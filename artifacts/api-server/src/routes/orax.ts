import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
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
import {
  buildOraxSandboxPatch,
  runOraxSandboxValidation,
  type OraxSandboxChangedFile,
  type OraxSandboxCheck,
  type OraxSandboxPatchedFile,
  type OraxSandboxValidation,
} from "../lib/orax-sandbox";
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
  prompt: z.string().trim().min(1).max(8000),
  title: z.string().min(1).max(140).optional(),
});

const composerAttachmentSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  name: z.string().min(1).max(300),
  type: z.string().max(200).optional(),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024)
    .optional(),
  source: z.enum(["web", "mobile"]).optional(),
  contentKind: z.enum(["text", "image", "binary", "unsupported"]).optional(),
  contentText: z.string().max(120_000).optional(),
  dataUrl: z.string().max(1_500_000).optional(),
  preview: z.string().max(1200).optional(),
  truncated: z.boolean().optional(),
  ingestionStatus: z.enum(["ready", "unsupported", "error"]).optional(),
});

const composerMetadataSchema = z.object({
  model: z.string().min(1).max(80).optional(),
  reasoning: z.enum(["low", "medium", "high", "extra_high"]).optional(),
  permissionMode: z.enum(["ask", "auto", "read_only"]).optional(),
  inputMode: z.enum(["text", "voice"]).optional(),
  attachments: z.array(composerAttachmentSchema).max(6).optional(),
});

const taskMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  metadata: z
    .object({
      composer: composerMetadataSchema.optional(),
    })
    .passthrough()
    .optional(),
});

type OraxComposerAttachmentInput = z.infer<typeof composerAttachmentSchema>;

type OraxComposerAttachmentAnalysis = {
  summary: string;
  aiSummary?: string;
  aiSuggestedFocus?: string[];
  aiDetectedPaths?: string[];
  aiProvider?: string;
  aiModel?: string;
  aiStatus?: "completed" | "unavailable" | "failed";
  aiError?: string;
  attachments: Array<{
    name: string;
    contentKind: string;
    ingestionStatus: string;
    readable: boolean;
    signals: string[];
    detectedPaths: string[];
    errors: string[];
    commands: string[];
    frameworks: string[];
    languages: string[];
    image?: {
      mimeType: string;
      width?: number;
      height?: number;
      likelyScreenshot: boolean;
    };
  }>;
  detectedPaths: string[];
  errors: string[];
  commands: string[];
  frameworks: string[];
  languages: string[];
  suggestedFocus: string[];
};

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

type OraxSlashCommandName = "help" | "plan" | "goal" | "review" | "status" | "scan" | "connect";

type OraxSlashCommand = {
  name: OraxSlashCommandName;
  args: string;
  raw: string;
};

type OraxSlashCommandResult = {
  task: OraxTask;
  content: string;
  actionSuggestions: OraxTaskActionSuggestion[];
  metadata: Record<string, unknown>;
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
    workspaceChangeSets: number;
    commandResults: number;
    githubPrResults: number;
    total: number;
  };
  latestBlocker: string | null;
  nextStep: string;
  updatedAt: string;
};

type OraxTaskRunnerResult = {
  status: "continued" | "waiting" | "blocked";
  action:
    | "review_pending_approval"
    | "run_approved_read"
    | "run_approved_sandbox"
    | "run_approved_checks"
    | "run_approved_pr"
    | "request_read_approval"
    | "draft_patch"
    | "create_workspace_change_set"
    | "request_sandbox_approval"
    | "request_check_approval"
    | "retry_failed_patch"
    | "await_pr_confirmation"
    | "complete"
    | "blocked";
  message: string;
  approvalId?: number;
  artifactId?: number;
  sessionArtifactId?: number;
  approval?: OraxTaskApproval;
  artifact?: OraxTaskArtifact;
  approvals?: OraxTaskApproval[];
  artifacts?: OraxTaskArtifact[];
  runnerResults?: Array<{
    status: "continued" | "waiting" | "blocked";
    action: string;
    message: string;
    approvalId?: number;
    artifactId?: number;
    sessionArtifactId?: number;
  }>;
};

type OraxExecutionStepStatus = "running" | "completed" | "waiting" | "blocked" | "failed";

type OraxExecutionSessionStep = {
  id: string;
  action: OraxTaskRunnerResult["action"];
  label: string;
  status: OraxExecutionStepStatus;
  message: string;
  approvalId?: number;
  artifactId?: number;
  createdAt: string;
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

router.get("/orax/tasks/:id/events", async (req, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  const task = await loadOwnedTask(userId, taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  let lastMessageId = Number(req.header("Last-Event-ID") ?? 0);
  if (!Number.isFinite(lastMessageId) || lastMessageId < 0) lastMessageId = 0;

  const writeEvent = (event: string, data: unknown, id?: number) => {
    if (closed) return;
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sendMessages = async () => {
    try {
      const messages = await loadOraxTaskMessagesAfter({
        userId,
        taskId,
        afterId: lastMessageId,
      });
      for (const message of messages) {
        lastMessageId = Math.max(lastMessageId, message.id);
        writeEvent("message", { message }, message.id);
      }
    } catch (err) {
      logger.warn({ component: "orax", err, taskId }, "Failed to stream ORAX task events");
      writeEvent("error", { error: "Failed to load ORAX task events" });
    }
  };

  writeEvent("ready", { taskId, lastMessageId });
  await sendMessages();

  const pollTimer = setInterval(() => {
    void sendMessages();
  }, 2_000);
  const keepAliveTimer = setInterval(() => {
    if (!closed) res.write(": keep-alive\n\n");
  }, 25_000);

  req.on("close", () => {
    closed = true;
    clearInterval(pollTimer);
    clearInterval(keepAliveTimer);
    res.end();
  });
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

    const composerMetadata = parsed.data.metadata?.composer
      ? {
          ...parsed.data.metadata.composer,
          attachments: normalizeOraxComposerAttachments(
            parsed.data.metadata.composer.attachments ?? [],
          ),
        }
      : undefined;
    const userMessageContext = buildOraxComposerAttachmentContext(composerMetadata?.attachments);
    const attachmentAnalysis = await enhanceOraxComposerAttachmentAnalysisWithAi(
      buildOraxComposerAttachmentAnalysis(composerMetadata?.attachments, parsed.data.content),
      composerMetadata?.attachments,
      parsed.data.content,
    );
    const attachmentAnalysisContext = attachmentAnalysis
      ? buildOraxAttachmentAnalysisContext(attachmentAnalysis)
      : null;
    const effectiveUserMessage = [
      parsed.data.content,
      attachmentAnalysisContext,
      userMessageContext,
    ]
      .filter(Boolean)
      .join("\n\n");
    const now = new Date();
    const [message] = await db
      .insert(oraxTaskMessagesTable)
      .values({
        userId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        role: "user",
        content: parsed.data.content,
        metadata: {
          ...(parsed.data.metadata ?? {}),
          ...(composerMetadata
            ? {
                composer: composerMetadata,
                attachmentContext: userMessageContext,
                attachmentAnalysis,
              }
            : {}),
          source: "orax-task-thread",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const slashCommand = parseOraxSlashCommand(parsed.data.content);
    if (slashCommand) {
      const latestState = await loadOraxTaskRunnerState(userId, task.id);
      const checkpoint = buildOraxCheckpointSummary({
        task,
        approvals: latestState.approvals,
        artifacts: latestState.artifacts,
      });
      const slashResult = await handleOraxSlashCommand({
        userId,
        task,
        command: slashCommand,
        checkpoint,
        approvals: latestState.approvals,
        artifacts: latestState.artifacts,
        userMessage: effectiveUserMessage,
      });
      const slashCheckpoint = buildOraxCheckpointSummary({
        task: slashResult.task,
        approvals: latestState.approvals,
        artifacts: latestState.artifacts,
      });
      const [assistantMessage] = await db
        .insert(oraxTaskMessagesTable)
        .values({
          userId,
          repositoryId: task.repositoryId,
          taskId: task.id,
          role: "assistant",
          content: slashResult.content,
          metadata: {
            source: "orax-task-thread",
            mode: "slash_command",
            slashCommand: slashCommand.name,
            slashCommandArgs: slashCommand.args,
            checkpoint: slashCheckpoint,
            actionSuggestions: slashResult.actionSuggestions,
            runnerAutoStarted: false,
            runnerResult: null,
            ...slashResult.metadata,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      await db
        .update(oraxTasksTable)
        .set({
          result: {
            ...asRecord(slashResult.task.result),
            currentCheckpoint: slashCheckpoint,
          },
          updatedAt: new Date(),
        })
        .where(eq(oraxTasksTable.id, task.id));

      res.status(201).json({ messages: [message, assistantMessage] });
      return;
    }

    const shouldAutoRun = shouldAutoRunOraxTaskFromMessage(
      parsed.data.content,
      composerMetadata?.attachments,
    );
    const runnerResult = shouldAutoRun
      ? await continueOraxTaskRunnerUntilStop({ userId, task })
      : undefined;
    const latestTask = (await loadOwnedTask(userId, task.id)) ?? task;
    const latestState = await loadOraxTaskRunnerState(userId, task.id);
    const actionSuggestions = buildOraxTaskActionSuggestions({
      task: latestTask,
      approvals: latestState.approvals,
      artifacts: latestState.artifacts,
      userMessage: effectiveUserMessage,
      attachmentAnalysis,
    });
    const checkpoint = buildOraxCheckpointSummary({
      task: latestTask,
      approvals: latestState.approvals,
      artifacts: latestState.artifacts,
    });
    const assistantContent = buildOraxTaskThreadReply({
      task: latestTask,
      approvals: latestState.approvals,
      artifacts: latestState.artifacts,
      actionSuggestions,
      checkpoint,
      userMessage: effectiveUserMessage,
      attachmentContext: userMessageContext,
      attachmentAnalysis,
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
          taskStatus: latestTask.status,
          approvalCount: latestState.approvals.length,
          artifactCount: latestState.artifacts.length,
          checkpoint,
          composer: composerMetadata ?? null,
          attachmentContext: userMessageContext,
          attachmentAnalysis,
          resumeMode: isOraxResumeQuestion(effectiveUserMessage),
          actionSuggestions,
          runnerAutoStarted: shouldAutoRun,
          runnerResult: runnerResult
            ? {
                status: runnerResult.status,
                action: runnerResult.action,
                approvalId: runnerResult.approvalId,
                artifactId: runnerResult.artifactId,
                runnerResults: runnerResult.runnerResults,
              }
            : null,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    await db
      .update(oraxTasksTable)
      .set({
        result: {
          ...asRecord(latestTask.result),
          currentCheckpoint: checkpoint,
        },
        updatedAt: new Date(),
      })
      .where(eq(oraxTasksTable.id, task.id));

    res.status(201).json({ messages: [message, assistantMessage], runnerResult });
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
    if (
      !task ||
      !artifact ||
      artifact.taskId !== task.id ||
      !["sandbox_result", "workspace_change_set"].includes(artifact.type)
    ) {
      res.status(404).json({ error: "Task or workspace artifact not found" });
      return;
    }

    const payload = asRecord(artifact.payload);
    if (artifact.status !== "completed" || payload.applied !== true) {
      res.status(409).json({ error: "Controlled checks require a prepared workspace change set" });
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
      content: `Controlled-check approval requested for workspace artifact #${artifact.id}.`,
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

router.post("/orax/tasks/:id/continue", async (req, res) => {
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

    const result = await continueOraxTaskRunnerUntilStop({ userId, task });
    res.json(result);
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to continue ORAX task");
    res.status(500).json({ error: "Failed to continue ORAX task" });
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
    const sourceArtifactId =
      typeof request.artifactId === "number" ? request.artifactId : Number(request.artifactId);
    const sourceArtifact = Number.isInteger(sourceArtifactId)
      ? await loadOwnedArtifact(userId, sourceArtifactId)
      : undefined;
    if (!task || !repository || !sourceArtifact || sourceArtifact.taskId !== task.id) {
      res.status(404).json({ error: "Task, repository, or workspace artifact not found" });
      return;
    }
    let context: OraxWorkspacePatchContext;
    try {
      context = await buildOraxWorkspacePatchContext({
        userId,
        task,
        repository,
        sourceArtifact,
      });
    } catch (err) {
      res.status(409).json({
        error: err instanceof Error ? err.message : "Could not prepare workspace changes",
      });
      return;
    }
    if (!context.validation.applied || !context.patchedFiles.length) {
      res
        .status(409)
        .json({ error: "Workspace change set no longer applies to the current branch" });
      return;
    }

    const token = repository.encryptedToken
      ? encryptionService.decrypt(repository.encryptedToken)
      : undefined;
    const requestCommands = Array.isArray(request.commands)
      ? request.commands.filter((item): item is string => typeof item === "string")
      : undefined;
    const commands = normalizeOraxSandboxCommandIds(requestCommands);
    const repositoryArchive = hasOraxWorkspaceCommandIds(commands)
      ? await downloadGithubRepositoryTarball({
          owner: repository.owner,
          repo: repository.name,
          branch: context.branch,
          token,
        })
      : null;
    const commandResult = await runOraxIsolatedWorkspaceChecks({
      commands,
      patchedFiles: context.patchedFiles,
      staticChecks: context.validation.checks,
      repositoryArchive,
    });
    const commandPayload = {
      sourceArtifactId: context.sandboxArtifact.id,
      workspaceChangeSetArtifactId: context.workspaceChangeSetArtifact?.id,
      draftArtifactId: context.draftArtifact.id,
      sourceApprovalId: context.sourceApproval.id,
      branch: context.branch,
      executedAt: new Date().toISOString(),
      ...commandResult,
      validation: {
        applied: context.validation.applied,
        changedFiles: context.validation.changedFiles,
        errors: context.validation.errors,
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
        title: `Controlled checks for ${sourceArtifact.title}`,
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
    let branch = sourceRequest.branch || repository.defaultBranch;
    const token = encryptionService.decrypt(repository.encryptedToken);
    const workspaceChangeSetArtifactId = numberFromOraxPayload(
      commandPayload.workspaceChangeSetArtifactId,
    );
    const workspaceChangeSetArtifact = workspaceChangeSetArtifactId
      ? await loadOwnedArtifact(userId, workspaceChangeSetArtifactId)
      : undefined;
    const workspacePayload =
      workspaceChangeSetArtifact?.type === "workspace_change_set" &&
      workspaceChangeSetArtifact.taskId === task.id
        ? asRecord(workspaceChangeSetArtifact.payload)
        : {};
    const workspaceValidation = normalizeOraxWorkspaceValidation(workspacePayload);
    const workspacePatchedFiles = normalizeOraxPatchedFiles(workspacePayload.patchedFiles);
    let sandbox: {
      validation: OraxSandboxValidation;
      patchedFiles: OraxSandboxPatchedFile[];
    } | null = null;
    if (workspaceValidation?.applied && workspacePatchedFiles.length) {
      branch = stringFromOraxPayload(workspacePayload.branch) || branch;
      sandbox = {
        validation: workspaceValidation,
        patchedFiles: workspacePatchedFiles,
      };
    }
    if (!sandbox) {
      const paths = normalizeOraxFileReadPaths(sourceRequest.paths ?? []);
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
      sandbox = buildOraxSandboxPatch({
        unifiedDiff,
        files: readResult.files,
        suggestedTests: tests,
      });
    }
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
      workspaceChangeSetArtifactId: workspaceChangeSetArtifact?.id,
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
        workspaceChangeSetArtifactId: workspaceChangeSetArtifact?.id,
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
    res.status(400).json({ error: "Start a new Orax chat with a repository and message." });
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
          message: "Orax created the task and is ready to work in the thread.",
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
  workspaceChangeSetArtifactId?: number;
  commandArtifactId: number;
  githubApprovalId: number;
}) {
  return [
    { label: "Read approval", id: input.readApprovalId, kind: "approval" },
    { label: "Draft patch", id: input.draftArtifactId, kind: "artifact" },
    { label: "Sandbox validation", id: input.sandboxArtifactId, kind: "artifact" },
    input.workspaceChangeSetArtifactId
      ? { label: "Workspace change set", id: input.workspaceChangeSetArtifactId, kind: "artifact" }
      : null,
    { label: "Workspace checks", id: input.commandArtifactId, kind: "artifact" },
    { label: "GitHub PR approval", id: input.githubApprovalId, kind: "approval" },
  ].filter((item): item is { label: string; id: number; kind: string } => Boolean(item));
}

async function continueOraxTaskRunner(input: {
  userId: string;
  task: OraxTask;
}): Promise<OraxTaskRunnerResult> {
  const { approvals, artifacts, messages } = await loadOraxTaskRunnerState(
    input.userId,
    input.task.id,
  );
  const session = await ensureOraxExecutionSession({
    userId: input.userId,
    task: input.task,
    artifacts,
  });

  const pendingApproval = approvals.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session,
      status: "waiting",
      action: "review_pending_approval",
      message: `Review approval #${pendingApproval.id} before Orax continues.`,
      approvalId: pendingApproval.id,
    });
  }

  const approvedApproval = approvals.find((approval) => approval.status === "approved");
  if (approvedApproval) {
    if (approvedApproval.action === "read_files") {
      return runOraxRunnerApprovedFileRead({
        userId: input.userId,
        task: input.task,
        session,
        approval: approvedApproval,
      });
    }
    if (approvedApproval.action === "sandbox_run") {
      return runOraxRunnerApprovedSandbox({
        userId: input.userId,
        task: input.task,
        session,
        approval: approvedApproval,
      });
    }
    if (approvedApproval.action === "safe_check") {
      return runOraxRunnerApprovedChecks({
        userId: input.userId,
        task: input.task,
        session,
        approval: approvedApproval,
      });
    }
    if (approvedApproval.action === "github_pr") {
      return persistOraxRunnerResult({
        userId: input.userId,
        task: input.task,
        session,
        status: "waiting",
        action: "run_approved_pr",
        message:
          "GitHub PR approval is approved. Use the inline PR approval action to create the branch and pull request.",
        approvalId: approvedApproval.id,
      });
    }
  }

  const latestGithubPrResult = artifacts.find(
    (artifact) => artifact.type === "github_pr_result" && artifact.status === "completed",
  );
  if (latestGithubPrResult) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session,
      status: "waiting",
      action: "complete",
      message: "This task already has a completed GitHub PR result.",
      artifactId: latestGithubPrResult.id,
    });
  }

  const latestCommandResult = artifacts.find((artifact) => artifact.type === "command_result");
  const latestCommandPayload = asRecord(latestCommandResult?.payload);
  if (latestCommandResult?.status === "completed" && latestCommandPayload.passed === true) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session,
      status: "waiting",
      action: "await_pr_confirmation",
      message:
        "Controlled checks passed. Type CREATE PR in the inline PR action when you want Orax to request pull request creation.",
      artifactId: latestCommandResult.id,
    });
  }

  const latestRetryableFailure = findLatestOraxRetryableFailure(artifacts);
  if (latestRetryableFailure) {
    const retryDraft = findOraxRetryDraftForFailure(artifacts, latestRetryableFailure.id);
    if (retryDraft) {
      if (!hasOraxValidationAfterDraft(artifacts, retryDraft.id)) {
        return requestOraxRunnerSandboxApproval({
          userId: input.userId,
          task: input.task,
          session,
          artifact: retryDraft,
        });
      }
    } else {
      return generateOraxRunnerRetryDraftPatch({
        userId: input.userId,
        task: input.task,
        session,
        artifacts,
        failureArtifact: latestRetryableFailure,
        instructions: latestOraxUserMessage(messages) ?? input.task.prompt,
      });
    }
  }

  const latestSandboxResult = artifacts.find((artifact) => artifact.type === "sandbox_result");
  const latestSandboxPayload = asRecord(latestSandboxResult?.payload);
  if (latestSandboxResult?.status === "completed" && latestSandboxPayload.applied === true) {
    const workspaceChangeSet = findOraxWorkspaceChangeSetForSandbox(
      artifacts,
      latestSandboxResult.id,
    );
    if (!workspaceChangeSet) {
      return createOraxRunnerWorkspaceChangeSet({
        userId: input.userId,
        task: input.task,
        session,
        sandboxArtifact: latestSandboxResult,
      });
    }
    return requestOraxRunnerCommandApproval({
      userId: input.userId,
      task: input.task,
      session,
      artifact: workspaceChangeSet,
    });
  }

  const latestDraftPatch = artifacts.find(
    (artifact) => artifact.type === "draft_patch" && artifact.status !== "rejected",
  );
  if (latestDraftPatch) {
    return requestOraxRunnerSandboxApproval({
      userId: input.userId,
      task: input.task,
      session,
      artifact: latestDraftPatch,
    });
  }

  const completedReadApproval = approvals.find(
    (approval) => approval.action === "read_files" && approval.status === "completed",
  );
  if (completedReadApproval) {
    return generateOraxRunnerDraftPatch({
      userId: input.userId,
      task: input.task,
      session,
      approval: completedReadApproval,
      instructions: latestOraxUserMessage(messages) ?? input.task.prompt,
    });
  }

  return requestOraxRunnerFileReadApproval({
    userId: input.userId,
    task: input.task,
    session,
    messages,
  });
}

const ORAX_RUNNER_AUTOPILOT_MAX_STEPS = 6;

async function continueOraxTaskRunnerUntilStop(input: {
  userId: string;
  task: OraxTask;
}): Promise<OraxTaskRunnerResult> {
  const results: OraxTaskRunnerResult[] = [];
  let task: OraxTask | undefined = input.task;

  for (let step = 0; step < ORAX_RUNNER_AUTOPILOT_MAX_STEPS; step += 1) {
    if (step > 0) {
      task = await loadOwnedTask(input.userId, input.task.id);
    }
    if (!task) {
      const blocked: OraxTaskRunnerResult = {
        status: "blocked",
        action: "blocked",
        message: "I could not find this Orax task.",
      };
      return withOraxRunnerBatchResult(blocked, [...results, blocked]);
    }

    const result = await continueOraxTaskRunner({ userId: input.userId, task });
    results.push(result);
    if (result.status !== "continued") {
      return withOraxRunnerBatchResult(result, results);
    }
  }

  const finalResult: OraxTaskRunnerResult = results[results.length - 1] ?? {
    status: "blocked",
    action: "blocked",
    message: "Orax could not find the next step.",
  };
  return withOraxRunnerBatchResult(finalResult, results);
}

function withOraxRunnerBatchResult(
  result: OraxTaskRunnerResult,
  results: OraxTaskRunnerResult[],
): OraxTaskRunnerResult {
  const approvals = uniqueOraxRunnerItems(
    results.flatMap((item) => (item.approval ? [item.approval] : (item.approvals ?? []))),
  );
  const artifacts = uniqueOraxRunnerItems(
    results.flatMap((item) => (item.artifact ? [item.artifact] : (item.artifacts ?? []))),
  );
  return {
    ...result,
    approvals,
    artifacts,
    runnerResults: results.map((item) => ({
      status: item.status,
      action: item.action,
      message: item.message,
      approvalId: item.approvalId,
      artifactId: item.artifactId,
      sessionArtifactId: item.sessionArtifactId,
    })),
  };
}

function uniqueOraxRunnerItems<T extends { id: number }>(items: T[]): T[] {
  const byId = new Map<number, T>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values());
}

async function loadOraxTaskRunnerState(userId: string, taskId: number) {
  const [approvals, artifacts, messages] = await Promise.all([
    db
      .select()
      .from(oraxTaskApprovalsTable)
      .where(
        and(eq(oraxTaskApprovalsTable.userId, userId), eq(oraxTaskApprovalsTable.taskId, taskId)),
      )
      .orderBy(desc(oraxTaskApprovalsTable.createdAt)),
    db
      .select()
      .from(oraxTaskArtifactsTable)
      .where(
        and(
          eq(oraxTaskArtifactsTable.userId, userId),
          eq(oraxTaskArtifactsTable.taskId, taskId),
          isNull(oraxTaskArtifactsTable.archivedAt),
        ),
      )
      .orderBy(desc(oraxTaskArtifactsTable.createdAt)),
    db
      .select()
      .from(oraxTaskMessagesTable)
      .where(
        and(
          eq(oraxTaskMessagesTable.userId, userId),
          eq(oraxTaskMessagesTable.taskId, taskId),
          isNull(oraxTaskMessagesTable.archivedAt),
        ),
      )
      .orderBy(desc(oraxTaskMessagesTable.createdAt))
      .limit(25),
  ]);

  return { approvals, artifacts, messages };
}

async function ensureOraxExecutionSession(input: {
  userId: string;
  task: OraxTask;
  artifacts: OraxTaskArtifact[];
}): Promise<OraxTaskArtifact> {
  const existing = input.artifacts.find(
    (artifact) => artifact.type === "execution_session" && artifact.status !== "completed",
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const [session] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: input.task.repositoryId,
      taskId: input.task.id,
      type: "execution_session",
      status: "running",
      title: `Execution session for ${input.task.title}`,
      summary: "Orax is working through this task inline.",
      payload: {
        taskId: input.task.id,
        status: "running",
        startedAt: now,
        updatedAt: now,
        steps: [],
      },
    })
    .returning();

  await persistOraxTimelineMessage({
    userId: input.userId,
    task: input.task,
    role: "system",
    event: "execution_session_started",
    content: "Orax started an execution session for this task.",
    artifactId: session.id,
    metadata: {
      executionSessionId: session.id,
      executionStep: {
        id: `session-${session.id}-start`,
        action: "request_read_approval",
        label: "Start execution session",
        status: "running",
        message: "Orax started an execution session for this task.",
        artifactId: session.id,
        createdAt: now,
      },
    },
  });

  return session;
}

async function appendOraxExecutionSessionStep(input: {
  userId: string;
  session: OraxTaskArtifact;
  action: OraxTaskRunnerResult["action"];
  status: OraxExecutionStepStatus;
  label: string;
  message: string;
  approvalId?: number;
  artifactId?: number;
}): Promise<OraxExecutionSessionStep> {
  const currentSession = (await loadOwnedArtifact(input.userId, input.session.id)) ?? input.session;
  const payload = asRecord(currentSession.payload);
  const steps = Array.isArray(payload.steps)
    ? payload.steps.filter((step): step is OraxExecutionSessionStep => {
        const record = asRecord(step);
        return (
          typeof record.id === "string" &&
          typeof record.action === "string" &&
          typeof record.label === "string" &&
          typeof record.status === "string" &&
          typeof record.message === "string" &&
          typeof record.createdAt === "string"
        );
      })
    : [];
  const createdAt = new Date().toISOString();
  const step: OraxExecutionSessionStep = {
    id: `session-${input.session.id}-step-${steps.length + 1}-${Date.now()}`,
    action: input.action,
    label: input.label,
    status: input.status,
    message: input.message,
    approvalId: input.approvalId,
    artifactId: input.artifactId,
    createdAt,
  };
  const sessionStatus = toOraxExecutionSessionStatus(input.action, input.status);

  await db
    .update(oraxTaskArtifactsTable)
    .set({
      status: sessionStatus,
      summary: `${step.label}: ${step.status}`,
      payload: {
        ...payload,
        taskId: input.session.taskId,
        status: sessionStatus,
        updatedAt: createdAt,
        steps: [...steps, step].slice(-80),
      },
      updatedAt: new Date(),
    })
    .where(eq(oraxTaskArtifactsTable.id, input.session.id));

  return step;
}

async function persistOraxExecutionProgress(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  action: OraxTaskRunnerResult["action"];
  label: string;
  message: string;
  approvalId?: number;
  artifactId?: number;
}): Promise<void> {
  const executionStep = await appendOraxExecutionSessionStep({
    ...input,
    status: "running",
  });

  await persistOraxTimelineMessage({
    userId: input.userId,
    task: input.task,
    role: "system",
    event: "execution_step",
    content: input.message,
    approvalId: input.approvalId,
    artifactId: input.artifactId,
    metadata: {
      runnerAction: input.action,
      runnerStatus: "running",
      executionSessionId: input.session.id,
      executionStep,
    },
  });
}

function toOraxExecutionStepStatus(
  status: OraxTaskRunnerResult["status"],
): OraxExecutionStepStatus {
  if (status === "continued") return "completed";
  if (status === "blocked") return "blocked";
  return "waiting";
}

function toOraxExecutionSessionStatus(
  action: OraxTaskRunnerResult["action"],
  status: OraxExecutionStepStatus,
): string {
  if (status === "failed" || status === "blocked") return "blocked";
  if (action === "complete" && status === "waiting") return "completed";
  if (status === "waiting") return "waiting";
  return "running";
}

function formatOraxExecutionStepLabel(action: OraxTaskRunnerResult["action"]): string {
  const labels: Record<OraxTaskRunnerResult["action"], string> = {
    review_pending_approval: "Review approval",
    run_approved_read: "Inspect files",
    run_approved_sandbox: "Check changes",
    run_approved_checks: "Run checks",
    run_approved_pr: "Create pull request",
    request_read_approval: "Inspect files",
    draft_patch: "Make changes",
    create_workspace_change_set: "Prepare changes",
    request_sandbox_approval: "Check changes",
    request_check_approval: "Run checks",
    retry_failed_patch: "Fix failure",
    await_pr_confirmation: "Wait for PR confirmation",
    complete: "Complete",
    blocked: "Blocked",
  };
  return labels[action];
}

async function persistOraxRunnerResult(input: {
  userId: string;
  task: OraxTask;
  session?: OraxTaskArtifact;
  status: OraxTaskRunnerResult["status"];
  action: OraxTaskRunnerResult["action"];
  message: string;
  approvalId?: number;
  artifactId?: number;
  approval?: OraxTaskApproval;
  artifact?: OraxTaskArtifact;
}): Promise<OraxTaskRunnerResult> {
  const executionStep = input.session
    ? await appendOraxExecutionSessionStep({
        userId: input.userId,
        session: input.session,
        action: input.action,
        status: toOraxExecutionStepStatus(input.status),
        label: formatOraxExecutionStepLabel(input.action),
        message: input.message,
        approvalId: input.approvalId,
        artifactId: input.artifactId,
      })
    : undefined;

  await persistOraxTimelineMessage({
    userId: input.userId,
    task: input.task,
    role: input.status === "continued" ? "tool" : "system",
    event: "runner_continue",
    content: input.message,
    approvalId: input.approvalId,
    artifactId: input.artifactId,
    metadata: {
      runnerAction: input.action,
      runnerStatus: input.status,
      executionSessionId: input.session?.id,
      executionStep,
    },
  });

  return {
    status: input.status,
    action: input.action,
    message: input.message,
    approvalId: input.approvalId,
    artifactId: input.artifactId,
    sessionArtifactId: input.session?.id,
    approval: input.approval,
    artifact: input.artifact,
  };
}

async function requestOraxRunnerFileReadApproval(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  messages: Array<{ role: string; content: string; metadata?: unknown }>;
}): Promise<OraxTaskRunnerResult> {
  const repository = await loadOwnedRepository(input.userId, input.task.repositoryId);
  if (!repository) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Connect an Orax repository before continuing this task.",
    });
  }
  if (repository.provider !== "github") {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Orax file-read approvals currently support GitHub repositories.",
    });
  }

  const paths = buildOraxRunnerReadPaths(input.task, input.messages);
  const request = {
    action: "read_files" as const,
    paths,
    branch: repository.defaultBranch,
    reason: "Continue Orax task by inspecting the source files needed for the next step.",
    limits: ORAX_FILE_READ_LIMITS,
  };
  const [approval] = await db
    .insert(oraxTaskApprovalsTable)
    .values({
      userId: input.userId,
      repositoryId: repository.id,
      taskId: input.task.id,
      action: "read_files",
      status: "pending",
      request,
      riskSummary:
        "ORAX will read selected repository files only. It will not edit files, run commands, push branches, open PRs, or deploy.",
    })
    .returning();

  await db
    .update(oraxTasksTable)
    .set({ status: "awaiting_approval", updatedAt: new Date() })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: "waiting",
    action: "request_read_approval",
    message: `File-read approval requested for ${paths.length} path${paths.length === 1 ? "" : "s"}.`,
    approvalId: approval.id,
    approval,
  });
}

async function runOraxRunnerApprovedFileRead(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  approval: OraxTaskApproval;
}): Promise<OraxTaskRunnerResult> {
  await persistOraxExecutionProgress({
    userId: input.userId,
    task: input.task,
    session: input.session,
    action: "run_approved_read",
    label: "Inspect files",
    message: "Inspecting the approved files...",
    approvalId: input.approval.id,
  });

  const repository = await loadOwnedRepository(input.userId, input.approval.repositoryId);
  if (!repository || repository.provider !== "github") {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Approved file reads currently support GitHub repositories.",
      approvalId: input.approval.id,
    });
  }

  const request = input.approval.request as { paths?: string[]; branch?: string };
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
    .where(eq(oraxTaskApprovalsTable.id, input.approval.id))
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      status: readResult.files.length ? "completed" : "blocked",
      result: {
        ...asRecord(input.task.result),
        fileRead: auditResult,
        message: readResult.files.length
          ? "ORAX inspected the approved files and can make the change next."
          : "ORAX could not inspect the approved files.",
      },
      updatedAt: new Date(),
      completedAt: readResult.files.length ? new Date() : null,
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: readResult.files.length ? "continued" : "blocked",
    action: "run_approved_read",
    message: readResult.files.length
      ? `Inspected ${readResult.files.length} file${readResult.files.length === 1 ? "" : "s"}.`
      : "No readable files were found.",
    approvalId: updatedApproval.id,
    approval: updatedApproval,
  });
}

async function generateOraxRunnerDraftPatch(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  approval: OraxTaskApproval;
  instructions: string;
}): Promise<OraxTaskRunnerResult> {
  await persistOraxExecutionProgress({
    userId: input.userId,
    task: input.task,
    session: input.session,
    action: "draft_patch",
    label: "Make changes",
    message: "Preparing the change from the inspected files...",
    approvalId: input.approval.id,
  });

  const repository = await loadOwnedRepository(input.userId, input.task.repositoryId);
  if (!repository) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Repository not found for draft patch generation.",
      approvalId: input.approval.id,
    });
  }

  const request = input.approval.request as { paths?: string[]; branch?: string };
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
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "No approved files could be read for draft patch generation.",
      approvalId: input.approval.id,
    });
  }

  const generated = await generateOraxDraftPatch({
    repositoryLabel: `${repository.owner}/${repository.name}`,
    taskPrompt: input.task.prompt,
    instructions: input.instructions.slice(0, 2000),
    branch,
    files: readResult.files.map((file) => ({
      path: file.path,
      content: file.content,
      size: file.size,
      sha: file.sha,
    })),
  });
  const [artifact] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: repository.id,
      taskId: input.task.id,
      approvalId: input.approval.id,
      type: "draft_patch",
      status: "draft",
      title: `Draft patch for ${input.task.title}`,
      summary: generated.summary,
      payload: {
        branch,
        approvalId: input.approval.id,
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
      },
    })
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      status: "awaiting_approval",
      result: {
        ...asRecord(input.task.result),
        draftPatch: {
          artifactId: artifact.id,
          summary: generated.summary,
          hasDiff: Boolean(generated.unifiedDiff.trim()),
        },
        message:
          "ORAX generated a draft patch preview. The next continue step can request sandbox approval.",
      },
      updatedAt: new Date(),
      completedAt: null,
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: "continued",
    action: "draft_patch",
    message: `Draft patch generated: ${generated.summary}`,
    approvalId: input.approval.id,
    artifactId: artifact.id,
    artifact,
  });
}

async function generateOraxRunnerRetryDraftPatch(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  artifacts: OraxTaskArtifact[];
  failureArtifact: OraxTaskArtifact;
  instructions: string;
}): Promise<OraxTaskRunnerResult> {
  await persistOraxExecutionProgress({
    userId: input.userId,
    task: input.task,
    session: input.session,
    action: "retry_failed_patch",
    label: "Fix failure",
    message: "Reviewing the failed result and drafting a fix attempt...",
    artifactId: input.failureArtifact.id,
  });

  const retrySource = resolveOraxRetrySource(input.failureArtifact);
  if (!retrySource) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Orax could not find the draft and file-read source for the failed result.",
      artifactId: input.failureArtifact.id,
    });
  }

  const [repository, sourceApproval, previousDraft] = await Promise.all([
    loadOwnedRepository(input.userId, input.task.repositoryId),
    loadOwnedApproval(input.userId, retrySource.sourceApprovalId),
    loadOwnedArtifact(input.userId, retrySource.draftArtifactId),
  ]);
  if (
    !repository ||
    !sourceApproval ||
    sourceApproval.action !== "read_files" ||
    !previousDraft ||
    previousDraft.type !== "draft_patch"
  ) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Orax could not reload the approved file context for retry drafting.",
      artifactId: input.failureArtifact.id,
    });
  }

  const request = sourceApproval.request as { paths?: string[]; branch?: string };
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
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "No approved files could be read for retry draft generation.",
      artifactId: input.failureArtifact.id,
    });
  }

  const previousPayload = asRecord(previousDraft.payload);
  const previousDiff =
    typeof previousPayload.unifiedDiff === "string" ? previousPayload.unifiedDiff : "";
  const retryInstructions = buildOraxRetryDraftInstructions({
    task: input.task,
    userInstructions: input.instructions,
    failureArtifact: input.failureArtifact,
    previousDraft,
    previousDiff,
  });
  const generated = await generateOraxDraftPatch({
    repositoryLabel: `${repository.owner}/${repository.name}`,
    taskPrompt: input.task.prompt,
    instructions: retryInstructions,
    branch,
    files: readResult.files.map((file) => ({
      path: file.path,
      content: file.content,
      size: file.size,
      sha: file.sha,
    })),
  });
  const retryAttempt = countOraxRetryDraftsForFailure(input.failureArtifact.id, input.artifacts);
  const [artifact] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: repository.id,
      taskId: input.task.id,
      approvalId: sourceApproval.id,
      type: "draft_patch",
      status: "draft",
      title: `Retry draft patch for ${input.task.title}`,
      summary: generated.summary,
      payload: {
        branch,
        approvalId: sourceApproval.id,
        model: process.env.ORAX_DRAFT_PATCH_MODEL || "gpt-5-mini",
        generatedAt: new Date().toISOString(),
        retryOfArtifactId: input.failureArtifact.id,
        retryOfArtifactType: input.failureArtifact.type,
        retrySourceDraftArtifactId: previousDraft.id,
        retryAttempt: retryAttempt + 1,
        failureSummary: summarizeOraxFailureArtifact(input.failureArtifact),
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
      },
    })
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      status: "awaiting_approval",
      result: {
        ...asRecord(input.task.result),
        retryDraftPatch: {
          artifactId: artifact.id,
          retryOfArtifactId: input.failureArtifact.id,
          summary: generated.summary,
          hasDiff: Boolean(generated.unifiedDiff.trim()),
        },
        message:
          "ORAX drafted a retry patch from the failed result. The next continue step can request sandbox approval.",
      },
      updatedAt: new Date(),
      completedAt: null,
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: "continued",
    action: "retry_failed_patch",
    message: `Retry draft generated from failed ${input.failureArtifact.type.replace(/_/g, " ")} artifact #${input.failureArtifact.id}: ${generated.summary}`,
    artifactId: artifact.id,
    artifact,
  });
}

async function requestOraxRunnerSandboxApproval(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  artifact: OraxTaskArtifact;
}): Promise<OraxTaskRunnerResult> {
  const payload = asRecord(input.artifact.payload);
  const unifiedDiff = typeof payload.unifiedDiff === "string" ? payload.unifiedDiff : "";
  if (!unifiedDiff.trim()) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "The change is not ready to check yet.",
      artifactId: input.artifact.id,
    });
  }

  const [approval] = await db
    .insert(oraxTaskApprovalsTable)
    .values({
      userId: input.userId,
      repositoryId: input.task.repositoryId,
      taskId: input.task.id,
      action: "sandbox_run",
      status: "pending",
      request: {
        artifactId: input.artifact.id,
        reason: "Check this change safely before moving on.",
        scope: "Check the prepared change without writing to the repository.",
      },
      riskSummary:
        "ORAX will check whether the prepared change applies cleanly. It will not write to the repository, run unrestricted commands, push, open a PR, or deploy.",
    })
    .returning();

  await db
    .update(oraxTasksTable)
    .set({ status: "awaiting_approval", updatedAt: new Date() })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: "waiting",
    action: "request_sandbox_approval",
    message: "Ready to check the prepared change.",
    approvalId: approval.id,
    artifactId: input.artifact.id,
    approval,
  });
}

async function runOraxRunnerApprovedSandbox(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  approval: OraxTaskApproval;
}): Promise<OraxTaskRunnerResult> {
  await persistOraxExecutionProgress({
    userId: input.userId,
    task: input.task,
    session: input.session,
    action: "run_approved_sandbox",
    label: "Check changes",
    message: "Checking the prepared change...",
    approvalId: input.approval.id,
  });

  const repository = await loadOwnedRepository(input.userId, input.approval.repositoryId);
  const request = asRecord(input.approval.request);
  const artifactId =
    typeof request.artifactId === "number" ? request.artifactId : Number(request.artifactId);
  const draftArtifact = Number.isInteger(artifactId)
    ? await loadOwnedArtifact(input.userId, artifactId)
    : undefined;
  if (!repository || !draftArtifact || draftArtifact.taskId !== input.task.id) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "I could not find the prepared change for this task.",
      approvalId: input.approval.id,
    });
  }

  const draftPayload = asRecord(draftArtifact.payload);
  const unifiedDiff = typeof draftPayload.unifiedDiff === "string" ? draftPayload.unifiedDiff : "";
  const sourceApprovalId =
    typeof draftArtifact.approvalId === "number" ? draftArtifact.approvalId : undefined;
  const sourceApproval = sourceApprovalId
    ? await loadOwnedApproval(input.userId, sourceApprovalId)
    : undefined;
  if (!sourceApproval || sourceApproval.action !== "read_files") {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "I need the inspected files before I can check this change.",
      approvalId: input.approval.id,
      artifactId: draftArtifact.id,
    });
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
  const tests = Array.isArray(draftPayload.tests)
    ? draftPayload.tests.filter((item): item is string => typeof item === "string")
    : [];
  const sandbox = runOraxSandboxValidation({
    unifiedDiff,
    files: readResult.files,
    suggestedTests: tests,
  });
  const [sandboxArtifact] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: repository.id,
      taskId: input.task.id,
      approvalId: input.approval.id,
      type: "sandbox_result",
      status: sandbox.applied ? "completed" : "failed",
      title: `Checked change for ${input.task.title}`,
      summary: sandbox.applied
        ? `Change checked for ${sandbox.changedFiles.length} file(s).`
        : "The change did not apply cleanly.",
      payload: {
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
      },
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
    .where(eq(oraxTaskApprovalsTable.id, input.approval.id))
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      status: sandbox.applied ? "completed" : "blocked",
      result: {
        ...asRecord(input.task.result),
        sandbox: {
          artifactId: sandboxArtifact.id,
          applied: sandbox.applied,
          changedFiles: sandbox.changedFiles.length,
          errors: sandbox.errors,
        },
        message: sandbox.applied
          ? "ORAX checked the prepared change successfully."
          : "ORAX could not check the prepared change successfully.",
      },
      updatedAt: new Date(),
      completedAt: sandbox.applied ? new Date() : null,
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: sandbox.applied ? "continued" : "blocked",
    action: "run_approved_sandbox",
    message: sandbox.applied
      ? `Checked ${sandbox.changedFiles.length} changed file${sandbox.changedFiles.length === 1 ? "" : "s"}.`
      : "The change did not apply cleanly.",
    approvalId: updatedApproval.id,
    artifactId: sandboxArtifact.id,
    approval: updatedApproval,
    artifact: sandboxArtifact,
  });
}

type OraxWorkspacePatchContext = {
  sandboxArtifact: OraxTaskArtifact;
  workspaceChangeSetArtifact?: OraxTaskArtifact;
  draftArtifact: OraxTaskArtifact;
  sourceApproval: OraxTaskApproval;
  branch: string;
  unifiedDiff: string;
  validation: OraxSandboxValidation;
  patchedFiles: OraxSandboxPatchedFile[];
  filesRead: Array<{ path: string; sha?: string; size?: number; truncated?: boolean }>;
  skipped: Array<{ path: string; reason: string }>;
};

async function createOraxRunnerWorkspaceChangeSet(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  sandboxArtifact: OraxTaskArtifact;
}): Promise<OraxTaskRunnerResult> {
  await persistOraxExecutionProgress({
    userId: input.userId,
    task: input.task,
    session: input.session,
    action: "create_workspace_change_set",
    label: "Prepare workspace changes",
    message: "Preparing a reviewable workspace change set from the validated patch...",
    artifactId: input.sandboxArtifact.id,
  });

  const existing = await findPersistedOraxWorkspaceChangeSetForSandbox({
    userId: input.userId,
    taskId: input.task.id,
    sandboxArtifactId: input.sandboxArtifact.id,
  });
  if (existing) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "continued",
      action: "create_workspace_change_set",
      message: `Workspace change set already ready for artifact #${input.sandboxArtifact.id}.`,
      artifactId: existing.id,
      artifact: existing,
    });
  }

  const repository = await loadOwnedRepository(input.userId, input.task.repositoryId);
  if (!repository) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Repository not found while preparing workspace changes.",
      artifactId: input.sandboxArtifact.id,
    });
  }

  let context: OraxWorkspacePatchContext;
  try {
    context = await buildOraxWorkspacePatchContext({
      userId: input.userId,
      task: input.task,
      repository,
      sourceArtifact: input.sandboxArtifact,
    });
  } catch (err) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: err instanceof Error ? err.message : "Could not prepare workspace changes.",
      artifactId: input.sandboxArtifact.id,
    });
  }
  if (!context.validation.applied || !context.patchedFiles.length) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "The validated patch no longer applies to the approved file snapshot.",
      artifactId: input.sandboxArtifact.id,
    });
  }

  const diffSummary = summarizeOraxUnifiedDiff(context.unifiedDiff);
  const changedFiles = context.validation.changedFiles;
  const [workspaceArtifact] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: repository.id,
      taskId: input.task.id,
      approvalId: input.sandboxArtifact.approvalId,
      type: "workspace_change_set",
      status: "completed",
      title: `Workspace change set for ${input.task.title}`,
      summary: `Workspace change set ready for ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}.`,
      payload: {
        sourceArtifactId: context.sandboxArtifact.id,
        draftArtifactId: context.draftArtifact.id,
        sourceApprovalId: context.sourceApproval.id,
        branch: context.branch,
        createdAt: new Date().toISOString(),
        applied: true,
        unifiedDiff: context.unifiedDiff,
        diffSummary,
        changedFiles,
        filesChanged: changedFiles.map((file) => file.path),
        filesRead: context.filesRead,
        skipped: context.skipped,
        validation: {
          applied: context.validation.applied,
          changedFiles: context.validation.changedFiles,
          checks: context.validation.checks,
          errors: context.validation.errors,
          testPreview: context.validation.testPreview,
        },
        patchedFiles: context.patchedFiles.map((file) => ({
          path: file.path,
          content: file.content,
          sourceSha: file.sourceSha,
          size: Buffer.byteLength(file.content, "utf8"),
        })),
        rollback: {
          sourceFiles: context.filesRead.map((file) => ({
            path: file.path,
            sha: file.sha,
            size: file.size,
            truncated: file.truncated,
          })),
        },
      },
    })
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      result: {
        ...asRecord(input.task.result),
        workspaceChangeSet: {
          artifactId: workspaceArtifact.id,
          changedFiles: changedFiles.length,
          sourceArtifactId: input.sandboxArtifact.id,
        },
        message: "ORAX prepared a reviewable workspace change set from the validated patch.",
      },
      updatedAt: new Date(),
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: "continued",
    action: "create_workspace_change_set",
    message: `Workspace change set ready: ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed.`,
    artifactId: workspaceArtifact.id,
    artifact: workspaceArtifact,
  });
}

async function requestOraxRunnerCommandApproval(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  artifact: OraxTaskArtifact;
}): Promise<OraxTaskRunnerResult> {
  const commands = normalizeOraxSandboxCommandIds([...ORAX_SANDBOX_COMMAND_IDS]);
  const [approval] = await db
    .insert(oraxTaskApprovalsTable)
    .values({
      userId: input.userId,
      repositoryId: input.task.repositoryId,
      taskId: input.task.id,
      action: "safe_check",
      status: "pending",
      request: {
        artifactId: input.artifact.id,
        commands,
        reason: "Run default Orax checks against the prepared workspace change set.",
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
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: "waiting",
    action: "request_check_approval",
    message: `Controlled-check approval requested for workspace artifact #${input.artifact.id}.`,
    approvalId: approval.id,
    artifactId: input.artifact.id,
    approval,
  });
}

async function buildOraxWorkspacePatchContext(input: {
  userId: string;
  task: OraxTask;
  repository: OraxRepository;
  sourceArtifact: OraxTaskArtifact;
}): Promise<OraxWorkspacePatchContext> {
  const sourcePayload = asRecord(input.sourceArtifact.payload);
  const workspaceChangeSetArtifact =
    input.sourceArtifact.type === "workspace_change_set" ? input.sourceArtifact : undefined;

  const sandboxArtifactId =
    input.sourceArtifact.type === "workspace_change_set"
      ? numberFromOraxPayload(sourcePayload.sourceArtifactId)
      : input.sourceArtifact.id;
  const sandboxArtifact =
    input.sourceArtifact.type === "sandbox_result"
      ? input.sourceArtifact
      : sandboxArtifactId
        ? await loadOwnedArtifact(input.userId, sandboxArtifactId)
        : undefined;
  if (!sandboxArtifact || sandboxArtifact.taskId !== input.task.id) {
    throw new Error("Workspace change set is missing its sandbox source");
  }
  if (sandboxArtifact.type !== "sandbox_result" || sandboxArtifact.status !== "completed") {
    throw new Error("Workspace checks require a completed sandbox source");
  }

  const sandboxPayload = asRecord(sandboxArtifact.payload);
  const draftArtifactId =
    input.sourceArtifact.type === "workspace_change_set"
      ? numberFromOraxPayload(sourcePayload.draftArtifactId)
      : numberFromOraxPayload(sandboxPayload.sourceArtifactId);
  const draftArtifact = draftArtifactId
    ? await loadOwnedArtifact(input.userId, draftArtifactId)
    : undefined;
  if (
    !draftArtifact ||
    draftArtifact.taskId !== input.task.id ||
    draftArtifact.type !== "draft_patch"
  ) {
    throw new Error("Workspace change set is missing its draft patch source");
  }

  const sourceApprovalId =
    numberFromOraxPayload(sourcePayload.sourceApprovalId) ??
    numberFromOraxPayload(sandboxPayload.sourceApprovalId) ??
    (typeof draftArtifact.approvalId === "number" ? draftArtifact.approvalId : null);
  const sourceApproval = sourceApprovalId
    ? await loadOwnedApproval(input.userId, sourceApprovalId)
    : undefined;
  if (!sourceApproval || sourceApproval.action !== "read_files") {
    throw new Error("Workspace change set is missing its approved file-read source");
  }

  const draftPayload = asRecord(draftArtifact.payload);
  const unifiedDiff = stringFromOraxPayload(sourcePayload.unifiedDiff)
    ? stringFromOraxPayload(sourcePayload.unifiedDiff)!
    : typeof draftPayload.unifiedDiff === "string"
      ? draftPayload.unifiedDiff
      : "";
  const branch =
    stringFromOraxPayload(sourcePayload.branch) ||
    stringFromOraxPayload(sandboxPayload.branch) ||
    (sourceApproval.request as { branch?: string }).branch ||
    input.repository.defaultBranch;

  const storedValidation = normalizeOraxWorkspaceValidation(sourcePayload);
  const storedPatchedFiles = normalizeOraxPatchedFiles(sourcePayload.patchedFiles);
  if (storedValidation?.applied && storedPatchedFiles.length) {
    return {
      sandboxArtifact,
      workspaceChangeSetArtifact,
      draftArtifact,
      sourceApproval,
      branch,
      unifiedDiff,
      validation: storedValidation,
      patchedFiles: storedPatchedFiles,
      filesRead: normalizeOraxFilesRead(sourcePayload.filesRead),
      skipped: normalizeOraxSkippedFiles(sourcePayload.skipped),
    };
  }

  const sourceRequest = sourceApproval.request as { paths?: string[]; branch?: string };
  const paths = normalizeOraxFileReadPaths(sourceRequest.paths ?? []);
  const token = input.repository.encryptedToken
    ? encryptionService.decrypt(input.repository.encryptedToken)
    : undefined;
  const readResult = await readGithubRepositoryFiles({
    owner: input.repository.owner,
    repo: input.repository.name,
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

  return {
    sandboxArtifact,
    workspaceChangeSetArtifact,
    draftArtifact,
    sourceApproval,
    branch,
    unifiedDiff,
    validation: sandbox.validation,
    patchedFiles: sandbox.patchedFiles,
    filesRead: readResult.files.map((file) => ({
      path: file.path,
      sha: file.sha,
      size: file.size,
      truncated: file.truncated,
    })),
    skipped: readResult.skipped,
  };
}

function normalizeOraxWorkspaceValidation(
  payload: Record<string, unknown>,
): OraxSandboxValidation | null {
  const validation = asRecord(payload.validation);
  const source = Object.keys(validation).length ? validation : payload;
  const changedFiles = normalizeOraxChangedFiles(source.changedFiles);
  const applied = source.applied === true || payload.applied === true;
  if (!applied && !changedFiles.length) return null;
  return {
    mode: "in_memory_patch_sandbox",
    applied,
    changedFiles,
    checks: normalizeOraxSandboxChecks(source.checks),
    errors: normalizeOraxStringList(source.errors),
    testPreview: normalizeOraxSandboxChecks(source.testPreview),
  };
}

function normalizeOraxPatchedFiles(value: unknown): OraxSandboxPatchedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => {
      const path = stringFromOraxPayload(item.path);
      const content = typeof item.content === "string" ? item.content : null;
      if (!path || content === null) return null;
      return {
        path,
        content,
        sourceSha: stringFromOraxPayload(item.sourceSha) ?? "",
      };
    })
    .filter((item): item is OraxSandboxPatchedFile => Boolean(item))
    .slice(0, ORAX_FILE_READ_LIMITS.maxFiles);
}

function normalizeOraxChangedFiles(value: unknown): OraxSandboxChangedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => {
      const path = stringFromOraxPayload(item.path);
      if (!path) return null;
      return {
        path,
        beforeBytes: numberFromOraxPayload(item.beforeBytes) ?? 0,
        afterBytes: numberFromOraxPayload(item.afterBytes) ?? 0,
        additions: numberFromOraxPayload(item.additions) ?? 0,
        deletions: numberFromOraxPayload(item.deletions) ?? 0,
      };
    })
    .filter((item): item is OraxSandboxChangedFile => Boolean(item))
    .slice(0, ORAX_FILE_READ_LIMITS.maxFiles);
}

function normalizeOraxSandboxChecks(value: unknown): OraxSandboxCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => {
      const name = stringFromOraxPayload(item.name);
      const status = stringFromOraxPayload(item.status);
      if (!name || !["passed", "failed", "not_run"].includes(status ?? "")) return null;
      return {
        name,
        status: status as OraxSandboxCheck["status"],
        message: stringFromOraxPayload(item.message) ?? "",
      };
    })
    .filter((item): item is OraxSandboxCheck => Boolean(item))
    .slice(0, 24);
}

function normalizeOraxFilesRead(
  value: unknown,
): Array<{ path: string; sha?: string; size?: number; truncated?: boolean }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => {
      const path = stringFromOraxPayload(item.path);
      if (!path) return null;
      const file: { path: string; sha?: string; size?: number; truncated?: boolean } = {
        path,
        sha: stringFromOraxPayload(item.sha) ?? undefined,
        size: numberFromOraxPayload(item.size) ?? undefined,
        truncated: typeof item.truncated === "boolean" ? item.truncated : undefined,
      };
      return file;
    })
    .filter((item): item is { path: string; sha?: string; size?: number; truncated?: boolean } =>
      Boolean(item),
    );
}

function normalizeOraxSkippedFiles(value: unknown): Array<{ path: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .map((item) => {
      const path = stringFromOraxPayload(item.path);
      if (!path) return null;
      return { path, reason: stringFromOraxPayload(item.reason) ?? "skipped" };
    })
    .filter((item): item is { path: string; reason: string } => Boolean(item));
}

function normalizeOraxStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 24);
}

function summarizeOraxUnifiedDiff(diff: string): { additions: number; deletions: number } {
  return diff.split("\n").reduce(
    (summary, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) summary.additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) summary.deletions += 1;
      return summary;
    },
    { additions: 0, deletions: 0 },
  );
}

async function runOraxRunnerApprovedChecks(input: {
  userId: string;
  task: OraxTask;
  session: OraxTaskArtifact;
  approval: OraxTaskApproval;
}): Promise<OraxTaskRunnerResult> {
  await persistOraxExecutionProgress({
    userId: input.userId,
    task: input.task,
    session: input.session,
    action: "run_approved_checks",
    label: "Run checks",
    message: "Running approved controlled checks in the isolated workspace...",
    approvalId: input.approval.id,
  });

  const repository = await loadOwnedRepository(input.userId, input.approval.repositoryId);
  const request = asRecord(input.approval.request);
  const sourceArtifactId =
    typeof request.artifactId === "number" ? request.artifactId : Number(request.artifactId);
  const sourceArtifact = Number.isInteger(sourceArtifactId)
    ? await loadOwnedArtifact(input.userId, sourceArtifactId)
    : undefined;
  if (!repository || !sourceArtifact || sourceArtifact.taskId !== input.task.id) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Task, repository, or workspace artifact not found.",
      approvalId: input.approval.id,
    });
  }

  let context: OraxWorkspacePatchContext;
  try {
    context = await buildOraxWorkspacePatchContext({
      userId: input.userId,
      task: input.task,
      repository,
      sourceArtifact,
    });
  } catch (err) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: err instanceof Error ? err.message : "Could not resolve workspace changes.",
      approvalId: input.approval.id,
      artifactId: sourceArtifact.id,
    });
  }
  if (!context.validation.applied || !context.patchedFiles.length) {
    return persistOraxRunnerResult({
      userId: input.userId,
      task: input.task,
      session: input.session,
      status: "blocked",
      action: "blocked",
      message: "Workspace change set no longer applies to the current branch.",
      approvalId: input.approval.id,
      artifactId: sourceArtifact.id,
    });
  }

  const token = repository.encryptedToken
    ? encryptionService.decrypt(repository.encryptedToken)
    : undefined;
  const requestCommands = Array.isArray(request.commands)
    ? request.commands.filter((item): item is string => typeof item === "string")
    : undefined;
  const commands = normalizeOraxSandboxCommandIds(requestCommands);
  const repositoryArchive = hasOraxWorkspaceCommandIds(commands)
    ? await downloadGithubRepositoryTarball({
        owner: repository.owner,
        repo: repository.name,
        branch: context.branch,
        token,
      })
    : null;
  const commandResult = await runOraxIsolatedWorkspaceChecks({
    commands,
    patchedFiles: context.patchedFiles,
    staticChecks: context.validation.checks,
    repositoryArchive,
  });
  const [commandArtifact] = await db
    .insert(oraxTaskArtifactsTable)
    .values({
      userId: input.userId,
      repositoryId: repository.id,
      taskId: input.task.id,
      approvalId: input.approval.id,
      type: "command_result",
      status: commandResult.passed ? "completed" : "failed",
      title: `Controlled checks for ${sourceArtifact.title}`,
      summary: commandResult.summary,
      payload: {
        sourceArtifactId: context.sandboxArtifact.id,
        workspaceChangeSetArtifactId: context.workspaceChangeSetArtifact?.id,
        draftArtifactId: context.draftArtifact.id,
        sourceApprovalId: context.sourceApproval.id,
        branch: context.branch,
        executedAt: new Date().toISOString(),
        ...commandResult,
        validation: {
          applied: context.validation.applied,
          changedFiles: context.validation.changedFiles,
          errors: context.validation.errors,
        },
      },
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
    .where(eq(oraxTaskApprovalsTable.id, input.approval.id))
    .returning();

  await db
    .update(oraxTasksTable)
    .set({
      status: commandResult.passed ? "completed" : "blocked",
      result: {
        ...asRecord(input.task.result),
        controlledChecks: {
          artifactId: commandArtifact.id,
          passed: commandResult.passed,
          commands: commandResult.commands.length,
        },
        message: commandResult.passed
          ? "ORAX ran approval-gated checks in an isolated temporary workspace."
          : "ORAX approval-gated checks failed.",
      },
      updatedAt: new Date(),
      completedAt: commandResult.passed ? new Date() : null,
    })
    .where(eq(oraxTasksTable.id, input.task.id));

  return persistOraxRunnerResult({
    userId: input.userId,
    task: input.task,
    session: input.session,
    status: commandResult.passed ? "continued" : "blocked",
    action: "run_approved_checks",
    message: commandResult.passed
      ? `Controlled checks passed: ${commandResult.commands.length} check${commandResult.commands.length === 1 ? "" : "s"} completed.`
      : `Controlled checks failed: ${commandResult.commands.length} check${commandResult.commands.length === 1 ? "" : "s"} completed.`,
    approvalId: updatedApproval.id,
    artifactId: commandArtifact.id,
    approval: updatedApproval,
    artifact: commandArtifact,
  });
}

function buildOraxRunnerReadPaths(
  task: OraxTask,
  messages: Array<{ role: string; content: string; metadata?: unknown }>,
): string[] {
  const suggestionPaths: string[] = [];
  for (const message of messages) {
    const metadata = asRecord(message.metadata);
    const suggestions = Array.isArray(metadata.actionSuggestions) ? metadata.actionSuggestions : [];
    for (const item of suggestions) {
      const suggestion = asRecord(item);
      if (suggestion.type !== "read_files" || !Array.isArray(suggestion.paths)) continue;
      suggestionPaths.push(
        ...suggestion.paths.filter((pathName): pathName is string => typeof pathName === "string"),
      );
    }
  }

  const merged = mergeOraxDetectedPaths([
    ...suggestionPaths,
    ...messages.flatMap((message) => extractOraxCandidatePaths(message.content)),
    ...extractOraxCandidatePaths(task.prompt),
    "README.md",
    "package.json",
    "tsconfig.json",
  ]).slice(0, ORAX_FILE_READ_LIMITS.maxFiles);
  return normalizeOraxFileReadPaths(merged);
}

function findLatestOraxRetryableFailure(artifacts: OraxTaskArtifact[]): OraxTaskArtifact | null {
  return artifacts.find((artifact) => isOraxRetryableFailureArtifact(artifact)) ?? null;
}

function isOraxRetryableFailureArtifact(artifact: OraxTaskArtifact): boolean {
  const payload = asRecord(artifact.payload);
  if (artifact.type === "sandbox_result") {
    return artifact.status === "failed" || payload.applied === false;
  }
  if (artifact.type === "command_result") {
    return artifact.status === "failed" || payload.passed === false;
  }
  return false;
}

function findOraxRetryDraftForFailure(
  artifacts: OraxTaskArtifact[],
  failureArtifactId: number,
): OraxTaskArtifact | null {
  return (
    artifacts.find((artifact) => {
      const payload = asRecord(artifact.payload);
      const retryOfArtifactId =
        typeof payload.retryOfArtifactId === "number"
          ? payload.retryOfArtifactId
          : Number(payload.retryOfArtifactId);
      return (
        artifact.type === "draft_patch" &&
        artifact.status !== "rejected" &&
        retryOfArtifactId === failureArtifactId
      );
    }) ?? null
  );
}

function hasOraxValidationAfterDraft(
  artifacts: OraxTaskArtifact[],
  draftArtifactId: number,
): boolean {
  return artifacts.some((artifact) => {
    const payload = asRecord(artifact.payload);
    if (artifact.type === "sandbox_result") {
      return numberFromOraxPayload(payload.sourceArtifactId) === draftArtifactId;
    }
    if (artifact.type === "workspace_change_set") {
      return numberFromOraxPayload(payload.draftArtifactId) === draftArtifactId;
    }
    if (artifact.type === "command_result") {
      return numberFromOraxPayload(payload.draftArtifactId) === draftArtifactId;
    }
    return false;
  });
}

function findOraxWorkspaceChangeSetForSandbox(
  artifacts: OraxTaskArtifact[],
  sandboxArtifactId: number,
): OraxTaskArtifact | null {
  return (
    artifacts.find((artifact) => {
      if (artifact.type !== "workspace_change_set" || artifact.status !== "completed") return false;
      const payload = asRecord(artifact.payload);
      return numberFromOraxPayload(payload.sourceArtifactId) === sandboxArtifactId;
    }) ?? null
  );
}

async function findPersistedOraxWorkspaceChangeSetForSandbox(input: {
  userId: string;
  taskId: number;
  sandboxArtifactId: number;
}): Promise<OraxTaskArtifact | null> {
  const artifacts = await db
    .select()
    .from(oraxTaskArtifactsTable)
    .where(
      and(
        eq(oraxTaskArtifactsTable.userId, input.userId),
        eq(oraxTaskArtifactsTable.taskId, input.taskId),
        eq(oraxTaskArtifactsTable.type, "workspace_change_set"),
        eq(oraxTaskArtifactsTable.status, "completed"),
        isNull(oraxTaskArtifactsTable.archivedAt),
      ),
    )
    .orderBy(desc(oraxTaskArtifactsTable.createdAt))
    .limit(25);

  return findOraxWorkspaceChangeSetForSandbox(artifacts, input.sandboxArtifactId);
}

function countOraxRetryDraftsForFailure(
  failureArtifactId: number,
  artifacts: OraxTaskArtifact[],
): number {
  return artifacts.filter((artifact) => {
    const payload = asRecord(artifact.payload);
    const retryOfArtifactId =
      typeof payload.retryOfArtifactId === "number"
        ? payload.retryOfArtifactId
        : Number(payload.retryOfArtifactId);
    return artifact.type === "draft_patch" && retryOfArtifactId === failureArtifactId;
  }).length;
}

function resolveOraxRetrySource(
  failureArtifact: OraxTaskArtifact,
): { draftArtifactId: number; sourceApprovalId: number } | null {
  const payload = asRecord(failureArtifact.payload);
  const draftArtifactId =
    failureArtifact.type === "command_result"
      ? numberFromOraxPayload(payload.draftArtifactId)
      : numberFromOraxPayload(payload.sourceArtifactId);
  const sourceApprovalId = numberFromOraxPayload(payload.sourceApprovalId);
  if (!draftArtifactId || !sourceApprovalId) return null;
  return { draftArtifactId, sourceApprovalId };
}

function numberFromOraxPayload(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function stringFromOraxPayload(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function buildOraxRetryDraftInstructions(input: {
  task: OraxTask;
  userInstructions: string;
  failureArtifact: OraxTaskArtifact;
  previousDraft: OraxTaskArtifact;
  previousDiff: string;
}): string {
  const failureDetails = summarizeOraxFailureArtifact(input.failureArtifact);
  const previousPayload = asRecord(input.previousDraft.payload);
  const previousSummary =
    typeof input.previousDraft.summary === "string" && input.previousDraft.summary.trim()
      ? input.previousDraft.summary.trim()
      : typeof previousPayload.explanation === "string"
        ? previousPayload.explanation
        : "Previous draft patch";

  return [
    "Create a retry draft patch that fixes the failed ORAX validation or check result.",
    "Keep the patch scoped to the same approved files. Do not add commands, pushes, deploy steps, or PR claims.",
    `Task: ${input.task.prompt}`,
    `User instructions: ${input.userInstructions}`,
    `Previous draft artifact #${input.previousDraft.id}: ${previousSummary}`,
    `Failure artifact #${input.failureArtifact.id} (${input.failureArtifact.type}):`,
    failureDetails,
    input.previousDiff
      ? `Previous unified diff, for context only:\n${truncateOraxRunnerText(input.previousDiff, 1400)}`
      : "No previous unified diff was available.",
  ]
    .join("\n\n")
    .slice(0, 5000);
}

function summarizeOraxFailureArtifact(artifact: OraxTaskArtifact): string {
  const payload = asRecord(artifact.payload);
  if (artifact.type === "sandbox_result") {
    const errors = Array.isArray(payload.errors)
      ? payload.errors.filter((item): item is string => typeof item === "string")
      : [];
    const changedFiles = Array.isArray(payload.changedFiles)
      ? payload.changedFiles
          .map((item) => asRecord(item))
          .map((item) => (typeof item.path === "string" ? item.path : null))
          .filter((item): item is string => Boolean(item))
      : [];
    return truncateOraxRunnerText(
      [
        artifact.summary ?? "Sandbox validation failed.",
        changedFiles.length ? `Changed files before failure: ${changedFiles.join(", ")}` : "",
        errors.length ? `Errors: ${errors.join("\n")}` : "No sandbox error details were recorded.",
      ]
        .filter(Boolean)
        .join("\n"),
      2400,
    );
  }

  if (artifact.type === "command_result") {
    const commands = Array.isArray(payload.commands)
      ? payload.commands.map((item) => asRecord(item))
      : [];
    const failedCommands = commands.filter((command) => command.status !== "passed");
    const details = failedCommands.length ? failedCommands : commands;
    return truncateOraxRunnerText(
      [
        artifact.summary ?? "Controlled checks failed.",
        ...details.map((command) => {
          const label =
            typeof command.label === "string"
              ? command.label
              : typeof command.id === "string"
                ? command.id
                : "unknown check";
          const status = typeof command.status === "string" ? command.status : "unknown";
          const message = typeof command.message === "string" ? command.message : "";
          const stdout = typeof command.stdout === "string" ? command.stdout : "";
          const stderr = typeof command.stderr === "string" ? command.stderr : "";
          return [
            `${label}: ${status}`,
            message ? `message: ${message}` : "",
            stdout ? `stdout:\n${truncateOraxRunnerText(stdout, 700)}` : "",
            stderr ? `stderr:\n${truncateOraxRunnerText(stderr, 900)}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      ].join("\n\n"),
      2800,
    );
  }

  return artifact.summary ?? "ORAX failure artifact recorded.";
}

function truncateOraxRunnerText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 24))}\n...[truncated]`;
}

function latestOraxUserMessage(messages: Array<{ role: string; content: string }>): string | null {
  return messages.find((message) => message.role === "user")?.content ?? null;
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

    logger.debug(
      { component: "orax", taskId: task.id, nextStep: checkpoint.nextStep },
      "Updated ORAX checkpoint",
    );
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
    workspaceChangeSets: input.artifacts.filter(
      (artifact) => artifact.type === "workspace_change_set",
    ).length,
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
    return "fix the latest issue before continuing.";
  }
  if (input.approvals.pending > 0) {
    return `review the pending approval${input.approvals.pending === 1 ? "" : "s"}.`;
  }
  if (input.hasCompletedPr) {
    return "review the pull request and keep the task thread updated.";
  }
  if (input.artifacts.commandResults > 0) {
    return "prepare the pull request if the checks passed.";
  }
  if (input.artifacts.sandboxResults > 0) {
    return "run checks on the change.";
  }
  if (input.artifacts.draftPatches > 0) {
    return "check the change.";
  }
  if (input.hasCompletedReadApproval) {
    return "make the change from the inspected files.";
  }
  return "inspect the relevant files.";
}

function normalizeOraxComposerAttachments(
  attachments: OraxComposerAttachmentInput[],
): OraxComposerAttachmentInput[] {
  return attachments.map((attachment) => {
    const contentText =
      typeof attachment.contentText === "string"
        ? truncateOraxAttachmentText(attachment.contentText, 120_000)
        : undefined;
    const dataUrl =
      typeof attachment.dataUrl === "string" && attachment.dataUrl.length <= 1_500_000
        ? attachment.dataUrl
        : undefined;
    const contentKind =
      attachment.contentKind ?? (contentText ? "text" : dataUrl ? "image" : "unsupported");
    const ingestionStatus =
      attachment.ingestionStatus ?? (contentText || dataUrl ? "ready" : "unsupported");
    const truncated =
      attachment.truncated ||
      (typeof attachment.contentText === "string" && attachment.contentText.length > 120_000) ||
      (typeof attachment.dataUrl === "string" && attachment.dataUrl.length > 1_500_000);

    return {
      ...attachment,
      contentKind,
      contentText,
      dataUrl,
      truncated,
      ingestionStatus,
      preview:
        attachment.preview ??
        buildOraxAttachmentPreview({
          ...attachment,
          contentKind,
          contentText,
          dataUrl,
          truncated,
          ingestionStatus,
        }),
    };
  });
}

function buildOraxAttachmentPreview(attachment: OraxComposerAttachmentInput): string | undefined {
  if (attachment.contentText?.trim()) {
    const text = attachment.contentText.replace(/\s+/g, " ").trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }
  if (attachment.dataUrl && attachment.type?.startsWith("image/")) {
    return `Image data attached for ${attachment.name}.`;
  }
  if (attachment.ingestionStatus === "unsupported") {
    return `No readable text or image data was extracted from ${attachment.name}.`;
  }
  return undefined;
}

function buildOraxComposerAttachmentContext(
  attachments: OraxComposerAttachmentInput[] | undefined,
): string | null {
  const usable = (attachments ?? []).filter(
    (attachment) => attachment.contentText?.trim() || attachment.dataUrl,
  );
  if (!usable.length) return null;

  const blocks = usable.map((attachment) => {
    const header = `Attachment: ${attachment.name} (${attachment.contentKind ?? "unknown"}${
      attachment.truncated ? ", truncated" : ""
    })`;
    if (attachment.contentText?.trim()) {
      return `${header}\n${attachment.contentText.trim()}`;
    }
    return `${header}\nImage data URL for visual/UI context:\n${attachment.dataUrl}`;
  });

  return `Orax attachment context:\n${blocks.join("\n\n")}`;
}

function truncateOraxAttachmentText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function buildOraxComposerAttachmentAnalysis(
  attachments: OraxComposerAttachmentInput[] | undefined,
  userMessage: string,
): OraxComposerAttachmentAnalysis | null {
  if (!attachments?.length) return null;

  const analyzed = attachments.map((attachment) =>
    analyzeOraxComposerAttachment(attachment, userMessage),
  );
  const detectedPaths = mergeOraxDetectedPaths(
    analyzed.flatMap((attachment) => attachment.detectedPaths),
  );
  const errors = uniqueOraxSignals(
    analyzed.flatMap((attachment) => attachment.errors),
    8,
  );
  const commands = uniqueOraxSignals(
    analyzed.flatMap((attachment) => attachment.commands),
    8,
  );
  const frameworks = uniqueOraxSignals(
    analyzed.flatMap((attachment) => attachment.frameworks),
    8,
  );
  const languages = uniqueOraxSignals(
    analyzed.flatMap((attachment) => attachment.languages),
    8,
  );
  const suggestedFocus = buildOraxAttachmentSuggestedFocus({
    attachments: analyzed,
    detectedPaths,
    errors,
    commands,
    frameworks,
    languages,
  });

  return {
    summary: summarizeOraxAttachmentAnalysis({
      attachmentCount: analyzed.length,
      textCount: analyzed.filter((attachment) => attachment.contentKind === "text").length,
      imageCount: analyzed.filter((attachment) => attachment.contentKind === "image").length,
      unsupportedCount: analyzed.filter((attachment) => !attachment.readable).length,
      errors,
      frameworks,
      languages,
      detectedPaths,
    }),
    attachments: analyzed,
    detectedPaths,
    errors,
    commands,
    frameworks,
    languages,
    suggestedFocus,
  };
}

async function enhanceOraxComposerAttachmentAnalysisWithAi(
  analysis: OraxComposerAttachmentAnalysis | null,
  attachments: OraxComposerAttachmentInput[] | undefined,
  userMessage: string,
): Promise<OraxComposerAttachmentAnalysis | null> {
  if (!analysis) return null;
  const readableAttachments = (attachments ?? []).filter(
    (attachment) => attachment.contentText?.trim() || attachment.dataUrl,
  );
  if (!readableAttachments.length) {
    return { ...analysis, aiStatus: "unavailable" };
  }

  try {
    const ai = await runOraxAiAttachmentAnalysis({
      analysis,
      attachments: readableAttachments,
      userMessage,
    });
    if (!ai) return { ...analysis, aiStatus: "unavailable" };

    return {
      ...analysis,
      aiSummary: ai.summary,
      aiSuggestedFocus: ai.suggestedFocus,
      aiDetectedPaths: ai.detectedPaths,
      aiProvider: ai.provider,
      aiModel: ai.model,
      aiStatus: "completed",
      detectedPaths: mergeOraxDetectedPaths([...analysis.detectedPaths, ...ai.detectedPaths]),
      suggestedFocus: uniqueOraxSignals([...ai.suggestedFocus, ...analysis.suggestedFocus], 5),
    };
  } catch (err) {
    logger.warn({ component: "orax", err }, "ORAX AI attachment analysis failed");
    return {
      ...analysis,
      aiStatus: "failed",
      aiError: err instanceof Error ? err.message : "AI attachment analysis failed",
    };
  }
}

async function runOraxAiAttachmentAnalysis(input: {
  analysis: OraxComposerAttachmentAnalysis;
  attachments: OraxComposerAttachmentInput[];
  userMessage: string;
}): Promise<{
  summary: string;
  suggestedFocus: string[];
  detectedPaths: string[];
  provider: string;
  model: string;
} | null> {
  const { createChatCompletion, resolveStageProvider, VISION_MODEL } =
    await import("../lib/ai-providers");
  const hasImages = input.attachments.some((attachment) => attachment.dataUrl);
  const { provider, model: routedModel } = resolveStageProvider("plan", "lite", "gpt-5-mini");
  let effectiveProvider = provider;
  let effectiveModel = routedModel;
  if (hasImages) {
    const visionModel = VISION_MODEL[provider];
    if (visionModel) {
      effectiveModel = visionModel;
    } else {
      effectiveProvider = "openai";
      effectiveModel = VISION_MODEL.openai ?? "gpt-5.4";
    }
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: buildOraxAiAttachmentAnalysisPrompt(input) }];
  for (const attachment of input.attachments.filter((item) => item.dataUrl).slice(0, 2)) {
    parts.push({ type: "image_url", image_url: { url: attachment.dataUrl! } });
  }

  const response = await createChatCompletion({
    provider: effectiveProvider,
    model: effectiveModel,
    response_format: { type: "json_object" },
    max_completion_tokens: 700,
    messages: [
      {
        role: "system",
        content:
          "You are ORAX, MustaFlow AI's coding-agent attachment analyst. Analyze only the supplied attachment context. Return strict JSON. Do not claim files were edited, commands were run, or PRs were created.",
      },
      { role: "user", content: parts as unknown as string },
    ],
    signal: AbortSignal.timeout(45_000),
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const parsed = parseOraxAiAttachmentAnalysisJson(raw);
  if (!parsed.summary) return null;
  return {
    ...parsed,
    provider: effectiveProvider,
    model: effectiveModel,
  };
}

function buildOraxAiAttachmentAnalysisPrompt(input: {
  analysis: OraxComposerAttachmentAnalysis;
  attachments: OraxComposerAttachmentInput[];
  userMessage: string;
}): string {
  const excerpts = input.attachments
    .filter((attachment) => attachment.contentText?.trim())
    .slice(0, 4)
    .map((attachment) => {
      const text = attachment.contentText!.trim().slice(0, 6000);
      return `--- ${attachment.name} (${attachment.contentKind ?? "text"}) ---\n${text}`;
    })
    .join("\n\n");
  const imageBriefs = input.analysis.attachments
    .filter((attachment) => attachment.image)
    .map((attachment) => {
      const image = attachment.image!;
      const size =
        image.width && image.height ? `${image.width}x${image.height}` : "unknown dimensions";
      return `${attachment.name}: ${image.mimeType}, ${size}, ${
        image.likelyScreenshot ? "likely screenshot/UI feedback" : "image context"
      }`;
    })
    .join("\n");

  return `User request:
${input.userMessage}

Deterministic attachment analysis:
${JSON.stringify(
  {
    summary: input.analysis.summary,
    detectedPaths: input.analysis.detectedPaths,
    errors: input.analysis.errors,
    commands: input.analysis.commands,
    frameworks: input.analysis.frameworks,
    languages: input.analysis.languages,
    suggestedFocus: input.analysis.suggestedFocus,
  },
  null,
  2,
)}

Image attachments:
${imageBriefs || "None"}

Readable text/code/log excerpts:
${excerpts || "None"}

Return strict JSON only:
{
  "summary": "one concise sentence about what the attachments show and how they affect the coding task",
  "suggestedFocus": ["1-5 concrete engineering next steps or inspection targets"],
  "detectedPaths": ["repository-relative file paths mentioned or strongly implied by the attachments"]
}

Rules:
- Keep the summary factual and short.
- If a screenshot is attached, describe the visible UI issue or target layout when clear.
- If logs/errors are attached, identify the likely failure signal.
- If code is attached, identify the likely component/module concern.
- Do not invent repository file paths that are not present or strongly implied.
- Do not claim execution, file edits, branch pushes, deployments, or pull requests happened.`;
}

function parseOraxAiAttachmentAnalysisJson(raw: string): {
  summary: string;
  suggestedFocus: string[];
  detectedPaths: string[];
} {
  try {
    const parsed = JSON.parse(stripOraxJsonFence(raw)) as Record<string, unknown>;
    return {
      summary:
        typeof parsed.summary === "string"
          ? parsed.summary.replace(/\s+/g, " ").trim().slice(0, 800)
          : "",
      suggestedFocus: Array.isArray(parsed.suggestedFocus)
        ? uniqueOraxSignals(
            parsed.suggestedFocus.filter((item): item is string => typeof item === "string"),
            5,
          )
        : [],
      detectedPaths: Array.isArray(parsed.detectedPaths)
        ? mergeOraxDetectedPaths(
            parsed.detectedPaths.filter((item): item is string => typeof item === "string"),
          )
        : [],
    };
  } catch {
    return { summary: "", suggestedFocus: [], detectedPaths: [] };
  }
}

function stripOraxJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function analyzeOraxComposerAttachment(
  attachment: OraxComposerAttachmentInput,
  userMessage: string,
): OraxComposerAttachmentAnalysis["attachments"][number] {
  const contentKind = attachment.contentKind ?? "unsupported";
  const ingestionStatus = attachment.ingestionStatus ?? "unsupported";
  const text = attachment.contentText?.trim() ?? "";
  const detectedPaths = mergeOraxDetectedPaths([
    ...(text ? extractOraxCandidatePaths(text) : []),
    ...extractOraxCandidatePaths(attachment.name),
  ]);
  const errors = text ? extractOraxAttachmentErrorSignals(text) : [];
  const commands = text ? extractOraxAttachmentCommandSignals(text) : [];
  const frameworks = text ? detectOraxAttachmentFrameworks(text) : [];
  const languages = detectOraxAttachmentLanguages(attachment.name, attachment.type, text);
  const image =
    attachment.dataUrl && contentKind === "image"
      ? analyzeOraxImageAttachment(attachment, userMessage)
      : undefined;
  const signals = uniqueOraxSignals(
    [
      ...errors.map((error) => `error: ${error}`),
      ...commands.map((command) => `command: ${command}`),
      ...frameworks.map((framework) => `framework: ${framework}`),
      ...languages.map((language) => `language: ${language}`),
      image?.likelyScreenshot ? "visual: likely screenshot" : undefined,
    ].filter((value): value is string => Boolean(value)),
    8,
  );

  return {
    name: attachment.name,
    contentKind,
    ingestionStatus,
    readable: Boolean(text || attachment.dataUrl),
    signals,
    detectedPaths,
    errors,
    commands,
    frameworks,
    languages,
    image,
  };
}

function analyzeOraxImageAttachment(
  attachment: OraxComposerAttachmentInput,
  userMessage: string,
): NonNullable<OraxComposerAttachmentAnalysis["attachments"][number]["image"]> {
  const parsed = parseOraxDataUrl(attachment.dataUrl ?? "");
  const dimensions = parsed ? parseOraxImageDimensions(parsed.mimeType, parsed.bytes) : null;
  const likelyScreenshot =
    /screenshot|screen|photo|ui|layout|button|mobile|web|app/i.test(
      `${attachment.name} ${userMessage}`,
    ) || Boolean(dimensions && Math.max(dimensions.width, dimensions.height) >= 900);

  return {
    mimeType: parsed?.mimeType ?? attachment.type ?? "image/*",
    width: dimensions?.width,
    height: dimensions?.height,
    likelyScreenshot,
  };
}

function parseOraxDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  try {
    return {
      mimeType: match[1] ?? "application/octet-stream",
      bytes: Buffer.from(match[2]!, "base64"),
    };
  } catch {
    return null;
  }
}

function parseOraxImageDimensions(
  mimeType: string,
  bytes: Buffer,
): { width: number; height: number } | null {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if ((mimeType === "image/jpeg" || mimeType === "image/jpg") && bytes.length > 4) {
    return parseOraxJpegDimensions(bytes);
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    return parseOraxWebpDimensions(bytes);
  }
  return null;
}

function parseOraxJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3 && offset + 8 < bytes.length) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function parseOraxWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function extractOraxAttachmentErrorSignals(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const matches = lines.filter((line) =>
    /\b(error|exception|traceback|failed|failure|cannot|can't|syntaxerror|typeerror|referenceerror|ts\d{4}|eslint|unhandled|stack)\b/i.test(
      line,
    ),
  );
  return uniqueOraxSignals(matches.map((line) => line.trim()).filter(Boolean), 8);
}

function extractOraxAttachmentCommandSignals(text: string): string[] {
  const matches =
    text.match(
      /\b(?:pnpm|npm|yarn|bun|node|npx|tsx|tsc|vite|vitest|jest|eslint|expo|gradle|xcodebuild|pod|ruby|python|pip|go|cargo|docker|git)\s+[^\r\n]{1,120}/g,
    ) ?? [];
  return uniqueOraxSignals(
    matches.map((command) => command.trim()),
    8,
  );
}

function detectOraxAttachmentFrameworks(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["React", /\breact\b|from ["']react["']|\.tsx?\b/i],
    ["Vite", /\bvite\b|vite\.config/i],
    ["Next.js", /\bnext\b|next\.config|app\/page\./i],
    ["Expo", /\bexpo\b|expo-router|react-native/i],
    ["React Native", /react-native|StyleSheet\.create/i],
    ["Express", /\bexpress\b|app\.(get|post|use)\(/i],
    ["Drizzle", /\bdrizzle\b|drizzle-orm/i],
    ["Prisma", /\bprisma\b|schema\.prisma/i],
    ["Tailwind", /\btailwind\b|className=/i],
    ["Vitest", /\bvitest\b|describe\(|expect\(/i],
  ];
  return checks
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label)
    .slice(0, 8);
}

function detectOraxAttachmentLanguages(
  name: string,
  type: string | undefined,
  text: string,
): string[] {
  const lower = name.toLowerCase();
  const languageByExtension: Array<[string, string]> = [
    [".tsx", "TypeScript React"],
    [".ts", "TypeScript"],
    [".jsx", "JavaScript React"],
    [".js", "JavaScript"],
    [".json", "JSON"],
    [".md", "Markdown"],
    [".css", "CSS"],
    [".html", "HTML"],
    [".py", "Python"],
    [".go", "Go"],
    [".rs", "Rust"],
    [".swift", "Swift"],
    [".kt", "Kotlin"],
    [".sql", "SQL"],
    [".yaml", "YAML"],
    [".yml", "YAML"],
  ];
  const fromExtension = languageByExtension
    .filter(([extension]) => lower.endsWith(extension))
    .map(([, language]) => language);
  const fromMime = type?.startsWith("text/") ? ["Text"] : [];
  const fromContent = [
    /\bimport\s+.+\s+from\b/.test(text) ? "JavaScript/TypeScript" : null,
    /<([A-Za-z][\w-]*)(\s|>)/.test(text) ? "Markup" : null,
  ].filter((value): value is string => Boolean(value));
  return uniqueOraxSignals([...fromExtension, ...fromMime, ...fromContent], 4);
}

function buildOraxAttachmentSuggestedFocus(input: {
  attachments: OraxComposerAttachmentAnalysis["attachments"];
  detectedPaths: string[];
  errors: string[];
  commands: string[];
  frameworks: string[];
  languages: string[];
}): string[] {
  const focus: string[] = [];
  if (input.detectedPaths.length) {
    focus.push(`Inspect ${input.detectedPaths.slice(0, 4).join(", ")}`);
  }
  if (input.errors.length) {
    focus.push("Address the detected error output");
  }
  if (input.commands.length) {
    focus.push(`Re-run or validate ${input.commands[0]}`);
  }
  const hasScreenshot = input.attachments.some((attachment) => attachment.image?.likelyScreenshot);
  if (hasScreenshot) {
    focus.push("Use the screenshot as visual/UI feedback");
  }
  if (input.frameworks.length) {
    focus.push(`Preserve the ${input.frameworks.slice(0, 3).join(", ")} patterns`);
  }
  if (!focus.length && input.languages.length) {
    focus.push(`Review the attached ${input.languages.slice(0, 2).join(" and ")} context`);
  }
  return uniqueOraxSignals(focus, 5);
}

function summarizeOraxAttachmentAnalysis(input: {
  attachmentCount: number;
  textCount: number;
  imageCount: number;
  unsupportedCount: number;
  errors: string[];
  frameworks: string[];
  languages: string[];
  detectedPaths: string[];
}): string {
  const parts = [`${input.attachmentCount} attachment${input.attachmentCount === 1 ? "" : "s"}`];
  if (input.textCount) parts.push(`${input.textCount} readable text/code`);
  if (input.imageCount) parts.push(`${input.imageCount} image/screenshot`);
  if (input.unsupportedCount) parts.push(`${input.unsupportedCount} unreadable`);
  const signals = [
    input.errors.length
      ? `${input.errors.length} error signal${input.errors.length === 1 ? "" : "s"}`
      : null,
    input.detectedPaths.length
      ? `${input.detectedPaths.length} file path${input.detectedPaths.length === 1 ? "" : "s"}`
      : null,
    input.frameworks.length ? input.frameworks.slice(0, 3).join(", ") : null,
    !input.frameworks.length && input.languages.length
      ? input.languages.slice(0, 3).join(", ")
      : null,
  ].filter(Boolean);
  return `Analyzed ${parts.join(", ")}${signals.length ? `; detected ${signals.join("; ")}` : ""}.`;
}

function buildOraxAttachmentAnalysisContext(analysis: OraxComposerAttachmentAnalysis): string {
  const lines = [
    `Orax attachment analysis: ${analysis.summary}`,
    analysis.aiSummary ? `AI summary: ${analysis.aiSummary}` : null,
    analysis.detectedPaths.length
      ? `Detected paths: ${analysis.detectedPaths.slice(0, 12).join(", ")}`
      : null,
    analysis.aiDetectedPaths?.length
      ? `AI detected paths: ${analysis.aiDetectedPaths.slice(0, 8).join(", ")}`
      : null,
    analysis.errors.length ? `Error signals: ${analysis.errors.slice(0, 5).join(" | ")}` : null,
    analysis.commands.length
      ? `Command signals: ${analysis.commands.slice(0, 5).join(" | ")}`
      : null,
    analysis.frameworks.length ? `Frameworks: ${analysis.frameworks.join(", ")}` : null,
    analysis.suggestedFocus.length
      ? `Suggested focus: ${analysis.suggestedFocus.join(" | ")}`
      : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function mergeOraxDetectedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((pathName) => !pathName.startsWith("http")))).slice(
    0,
    ORAX_FILE_READ_LIMITS.maxFiles,
  );
}

function uniqueOraxSignals(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    unique.push(normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized);
    if (unique.length >= max) break;
  }
  return unique;
}

function parseOraxSlashCommand(content: string): OraxSlashCommand | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!isOraxSlashCommandName(name)) return null;
  return {
    name,
    args: (match[2] ?? "").trim(),
    raw: trimmed,
  };
}

function isOraxSlashCommandName(value: string): value is OraxSlashCommandName {
  return ["help", "plan", "goal", "review", "status", "scan", "connect"].includes(value);
}

async function handleOraxSlashCommand(input: {
  userId: string;
  task: OraxTask;
  command: OraxSlashCommand;
  checkpoint: OraxCheckpointSummary;
  approvals: OraxTaskApproval[];
  artifacts: OraxTaskArtifact[];
  userMessage: string;
}): Promise<OraxSlashCommandResult> {
  if (input.command.name === "help") {
    return {
      task: input.task,
      content: [
        "Orax commands:",
        "/plan - shape the next implementation plan.",
        "/goal <goal> - set the active task goal.",
        "/review - start a review-focused pass.",
        "/status - summarize where the task stands.",
        "/scan - show the next repository scan step.",
        "/connect - show the repository connection step.",
      ].join("\n"),
      actionSuggestions: [],
      metadata: { slashCommandHelp: true },
    };
  }

  if (input.command.name === "status") {
    return {
      task: input.task,
      content: buildOraxCheckpointResumeReply(input.checkpoint),
      actionSuggestions: [],
      metadata: { slashCommandStatus: true },
    };
  }

  if (input.command.name === "goal") {
    const currentGoal = asRecord(asRecord(input.task.result).activeGoal);
    if (!input.command.args) {
      const objective =
        typeof currentGoal.objective === "string" && currentGoal.objective.trim()
          ? currentGoal.objective.trim()
          : null;
      return {
        task: input.task,
        content: objective
          ? `Current goal: ${objective}\nSend /goal followed by a new goal to update it.`
          : "No active goal yet. Send /goal followed by what done should mean for this task.",
        actionSuggestions: [],
        metadata: { slashCommandGoal: currentGoal },
      };
    }

    const activeGoal = {
      objective: input.command.args.slice(0, 2000),
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    const [updatedTask] = await db
      .update(oraxTasksTable)
      .set({
        result: {
          ...asRecord(input.task.result),
          activeGoal,
          message: `Active goal set: ${activeGoal.objective}`,
        },
        updatedAt: new Date(),
      })
      .where(eq(oraxTasksTable.id, input.task.id))
      .returning();

    return {
      task: updatedTask ?? input.task,
      content: `Goal set: ${activeGoal.objective}\nI’ll use that as the definition of done for this Orax task.`,
      actionSuggestions: [
        buildOraxReadFilesSuggestion({
          task: updatedTask ?? input.task,
          userMessage: input.command.args,
          title: "Inspect files",
          description: "Inspect the relevant files for this goal.",
        }),
      ],
      metadata: { slashCommandGoal: activeGoal },
    };
  }

  if (input.command.name === "plan") {
    const repository = await loadOwnedRepository(input.userId, input.task.repositoryId);
    const objective = input.command.args || input.task.prompt;
    const plan = repository
      ? buildOraxTaskPlan({
          kind: "plan",
          repository,
          prompt: objective,
        })
      : {
          mode: "read_only_foundation",
          objective,
          steps: [
            "Confirm the repository target.",
            "Inspect the relevant files before changing anything.",
            "Draft a focused implementation plan.",
            "Ask for approval before edits, checks, pushes, or PRs.",
          ],
          guardrails: ["Keep Orax isolated from Ora chat and AI Builder."],
          unavailableUntilApproved: ["File changes", "Command execution", "Pull requests"],
        };
    const [updatedTask] = await db
      .update(oraxTasksTable)
      .set({
        kind: "plan",
        plan,
        result: {
          ...asRecord(input.task.result),
          activePlan: {
            objective,
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(oraxTasksTable.id, input.task.id))
      .returning();

    return {
      task: updatedTask ?? input.task,
      content: [
        "Plan mode is on.",
        `Goal: ${plan.objective}`,
        ...plan.steps.slice(0, 4).map((step, index) => `${index + 1}. ${step}`),
        "I’ll inspect relevant files before making changes.",
      ].join("\n"),
      actionSuggestions: [
        buildOraxReadFilesSuggestion({
          task: updatedTask ?? input.task,
          userMessage: objective,
          title: "Inspect files",
          description: "Inspect the files needed for this plan.",
        }),
      ],
      metadata: { slashCommandPlan: plan },
    };
  }

  if (input.command.name === "review") {
    return {
      task: input.task,
      content:
        "Review mode is ready. I’ll inspect the relevant files first, then report findings before suggesting changes.",
      actionSuggestions: [
        buildOraxReadFilesSuggestion({
          task: input.task,
          userMessage: input.command.args || input.task.prompt,
          title: "Inspect for review",
          description: "Read the relevant files before reviewing.",
        }),
      ],
      metadata: { slashCommandReview: true },
    };
  }

  if (input.command.name === "scan") {
    return {
      task: input.task,
      content:
        "Use Scan files from the workspace controls to refresh repository context. After the scan, send your task and I’ll work from the updated file map.",
      actionSuggestions: [],
      metadata: { slashCommandScan: true },
    };
  }

  return {
    task: input.task,
    content:
      "Use Connect GitHub from the workspace controls to add or update repository access. Orax keeps this separate from Ora chat.",
    actionSuggestions: [],
    metadata: { slashCommandConnect: true },
  };
}

function buildOraxReadFilesSuggestion(input: {
  task: OraxTask;
  userMessage: string;
  title: string;
  description: string;
}): OraxTaskActionSuggestion {
  const paths = mergeOraxDetectedPaths(extractOraxCandidatePaths(input.userMessage));
  return {
    type: "read_files",
    title: input.title,
    description: input.description,
    buttonLabel: "Inspect files",
    paths,
    reason: `Slash command for ${input.task.title}`.slice(0, 1000),
  };
}

function buildOraxTaskThreadReply(input: {
  task: OraxTask;
  approvals: OraxTaskApproval[];
  artifacts: OraxTaskArtifact[];
  actionSuggestions: OraxTaskActionSuggestion[];
  checkpoint: OraxCheckpointSummary;
  userMessage: string;
  attachmentContext?: string | null;
  attachmentAnalysis?: OraxComposerAttachmentAnalysis | null;
}): string {
  if (isOraxResumeQuestion(input.userMessage)) {
    return buildOraxCheckpointResumeReply(input.checkpoint);
  }

  const pendingApprovals = input.approvals.filter((approval) => approval.status === "pending");
  const latestArtifact = input.artifacts[0];
  const suggestion = input.actionSuggestions[0];
  const nextStep =
    pendingApprovals.length > 0
      ? `There ${pendingApprovals.length === 1 ? "is" : "are"} ${pendingApprovals.length} pending approval${
          pendingApprovals.length === 1 ? "" : "s"
        }. Review the inline action when you are ready.`
      : latestArtifact
        ? formatOraxLatestResultForChat(latestArtifact)
        : suggestion
          ? "I'm ready to start from the inline action below."
          : "Tell me what to inspect or change next.";

  return [
    "I'll work from here.",
    input.attachmentAnalysis
      ? `I analyzed the attached context: ${
          input.attachmentAnalysis.aiSummary ?? input.attachmentAnalysis.summary
        }`
      : input.attachmentContext
        ? summarizeOraxAttachmentContext(input.attachmentContext)
        : null,
    nextStep,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOraxLatestResultForChat(artifact: OraxTaskArtifact): string {
  if (artifact.type === "draft_patch") {
    return "I prepared the change. I can check it next.";
  }
  if (artifact.type === "sandbox_result" || artifact.type === "workspace_change_set") {
    return artifact.status === "failed"
      ? "The change needs another pass. I can adjust it next."
      : "The change is ready for checks.";
  }
  if (artifact.type === "command_result") {
    const payload = asRecord(artifact.payload);
    return payload.passed === false
      ? "The checks found something. I can fix it next."
      : "The checks passed. I can prepare the pull request next.";
  }
  if (artifact.type === "github_pr_result") {
    return "The pull request is ready.";
  }
  return "I have the next result ready.";
}

function summarizeOraxAttachmentContext(context: string): string {
  const names = context
    .split("\n")
    .filter((line) => line.startsWith("Attachment: "))
    .map((line) => line.replace("Attachment: ", "").replace(/\s+\(.+\)$/, ""))
    .slice(0, 4);
  if (!names.length) return "I can use the attached context in this task.";
  return `I can use the attached context: ${names.join(", ")}.`;
}

function isOraxResumeQuestion(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "where are we",
    "where we at",
    "what happened",
    "what is next",
    "what's next",
    "next step",
    "resume",
    "continue",
    "catch me up",
    "status",
    "checkpoint",
  ].some((phrase) => normalized.includes(phrase));
}

function shouldAutoRunOraxTaskFromMessage(
  message: string,
  attachments?: OraxComposerAttachmentInput[],
): boolean {
  if (attachments?.some((attachment) => attachment.ingestionStatus === "ready")) return true;
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/^(hi|hello|hey|yo|test)[!. ]*$/.test(normalized)) return false;
  if (
    /\b(go ahead|continue|do it|start|run|fix|review|inspect|build|add|create|change|update|test|debug|check)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /\b(what happened|what is next|what's next|next step|what should|where are we|where we at|status|checkpoint|catch me up)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return normalized.length >= 8;
}

function buildOraxCheckpointResumeReply(checkpoint: OraxCheckpointSummary): string {
  const hasProgress =
    checkpoint.filesReviewed.length > 0 ||
    checkpoint.artifacts.total > 0 ||
    checkpoint.approvals.completed > 0;
  const progressLine = hasProgress
    ? checkpoint.filesReviewed.length
      ? `I've already reviewed ${checkpoint.filesReviewed.slice(0, 3).join(", ")}.`
      : "I've started the workflow and have saved the latest task state."
    : "Nothing has run yet.";
  const blockerLine = checkpoint.latestBlocker
    ? `Current blocker: ${checkpoint.latestBlocker}`
    : null;

  return [
    progressLine,
    blockerLine,
    `Next, I need to ${formatOraxNextStepForChat(checkpoint.nextStep)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOraxNextStepForChat(nextStep: string): string {
  const normalized = nextStep.trim().replace(/\.$/, "");
  if (!normalized) return "continue from the inline action";
  return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

function buildOraxTaskActionSuggestions(input: {
  task: OraxTask;
  approvals: OraxTaskApproval[];
  artifacts: OraxTaskArtifact[];
  userMessage: string;
  attachmentAnalysis?: OraxComposerAttachmentAnalysis | null;
}): OraxTaskActionSuggestion[] {
  const suggestions: OraxTaskActionSuggestion[] = [];
  const pendingApproval = input.approvals.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    suggestions.push({
      type: "review_pending_approval",
      title: "Review approval",
      description: "Confirm the next step so I can keep going.",
      buttonLabel: "Review approval",
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
      title: "Prepare pull request",
      description: "Prepare the pull request for review.",
      buttonLabel: "Prepare pull request",
      artifactId: latestCommandResult.id,
      requiresManualConfirmation: true,
    });
  }

  const latestSandboxResult = input.artifacts.find(
    (artifact) => artifact.type === "sandbox_result",
  );
  const latestWorkspaceChangeSet =
    latestSandboxResult &&
    findOraxWorkspaceChangeSetForSandbox(input.artifacts, latestSandboxResult.id);
  const latestSandboxPayload = asRecord(latestSandboxResult?.payload);
  if (latestWorkspaceChangeSet || (latestSandboxResult && latestSandboxPayload.applied === true)) {
    suggestions.push({
      type: "controlled_checks",
      title: "Run checks",
      description: "Run the usual checks on the change.",
      buttonLabel: "Run checks",
      artifactId: latestWorkspaceChangeSet?.id ?? latestSandboxResult?.id,
      commands: [...ORAX_SANDBOX_COMMAND_IDS],
    });
  }

  const latestDraftPatch = input.artifacts.find((artifact) => artifact.type === "draft_patch");
  if (latestDraftPatch && latestDraftPatch.status !== "rejected") {
    suggestions.push({
      type: "sandbox_run",
      title: "Check changes",
      description: "Check the change before moving on.",
      buttonLabel: "Check changes",
      artifactId: latestDraftPatch.id,
    });
  }

  const completedReadApproval = input.approvals.find(
    (approval) => approval.action === "read_files" && approval.status === "completed",
  );
  if (completedReadApproval) {
    suggestions.push({
      type: "draft_patch",
      title: "Make changes",
      description: "Use the inspected files to make the change.",
      buttonLabel: "Make changes",
      approvalId: completedReadApproval.id,
      instructions: input.userMessage.slice(0, 2000),
    });
  }

  const extractedPaths = mergeOraxDetectedPaths([
    ...extractOraxCandidatePaths(input.userMessage),
    ...(input.attachmentAnalysis?.detectedPaths ?? []),
  ]);
  const analyzedAttachments = Boolean(
    input.attachmentAnalysis?.attachments.some((item) => item.readable),
  );
  if (extractedPaths.length > 0 || suggestions.length === 0) {
    suggestions.push({
      type: "read_files",
      title: analyzedAttachments ? "Inspect related files" : "Inspect files",
      description:
        extractedPaths.length > 0
          ? "Review the detected files before changing anything."
          : analyzedAttachments
            ? "Review the files related to the attached context."
            : "Review the relevant files before changing anything.",
      buttonLabel: extractedPaths.length > 0 ? "Inspect files" : undefined,
      paths: extractedPaths,
      reason: (input.attachmentAnalysis?.suggestedFocus.length
        ? `Attachment analysis: ${input.attachmentAnalysis.suggestedFocus.join("; ")}`
        : `Task discussion: ${input.task.title}`
      ).slice(0, 1000),
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

async function loadOraxTaskMessagesAfter(input: {
  userId: string;
  taskId: number;
  afterId: number;
}) {
  return db
    .select()
    .from(oraxTaskMessagesTable)
    .where(
      and(
        eq(oraxTaskMessagesTable.userId, input.userId),
        eq(oraxTaskMessagesTable.taskId, input.taskId),
        gt(oraxTaskMessagesTable.id, input.afterId),
        isNull(oraxTaskMessagesTable.archivedAt),
      ),
    )
    .orderBy(asc(oraxTaskMessagesTable.id))
    .limit(100);
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
