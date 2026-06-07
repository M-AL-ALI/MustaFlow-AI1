import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  oraxRepositoriesTable,
  oraxRepositoryScansTable,
  oraxTaskApprovalsTable,
  oraxTaskArtifactsTable,
  oraxTasksTable,
  ORAX_PROVIDERS,
  ORAX_TASK_KINDS,
  type OraxTaskApproval,
  type OraxRepository,
  type OraxTask,
} from "@workspace/db";
import { generateOraxDraftPatch } from "../lib/orax-draft-patch";
import {
  buildOraxTaskPlan,
  normalizeOraxFileReadPaths,
  ORAX_FILE_READ_LIMITS,
  parseRepositoryLocator,
} from "../lib/orax";
import {
  readGithubRepositoryFiles,
  scanGithubRepository,
  verifyGithubReadOnlyToken,
} from "../lib/orax-github";
import { runOraxSandboxValidation } from "../lib/orax-sandbox";
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

router.get("/orax/capabilities", (_req, res) => {
  res.json({
    product: "ORAX",
    phase: "read_only_github_scan",
    mode: "read_only_repository_analysis",
    available: [
      "Register repository metadata",
      "Connect a GitHub token for read-only repository scans",
      "Scan repository metadata, branches, and file tree summaries",
      "Create coding-agent task plans",
      "Request approval to read selected source files",
      "Generate draft patch previews from approved file reads",
      "Request approval to validate draft patches in an isolated sandbox",
      "Store ORAX task history separately from Ora and AI Builder",
    ],
    lockedUntilApprovalLayer: [
      "Clone private repositories",
      "Edit files",
      "Run terminal commands",
      "Push branches",
      "Open pull requests",
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

    res.status(201).json({ approval });
  } catch (err) {
    logger.error({ component: "orax", err, taskId }, "Failed to create ORAX sandbox approval");
    res.status(500).json({ error: "Failed to create ORAX sandbox approval" });
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

    res.json({ approval: updatedApproval, artifact: sandboxArtifact });
  } catch (err) {
    logger.error({ component: "orax", err, approvalId }, "Failed to run ORAX sandbox validation");
    res.status(502).json({ error: "Could not run sandbox validation" });
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
