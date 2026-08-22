import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  agentTasksTable,
  projectSuggestionsTable,
  projectsTable,
  chatMessagesTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { enqueueJob } from "../lib/jobs";
import { logger } from "../lib/logger";
import { z } from "zod";
import type { AgentMode } from "../lib/ai";
import { projectSummaryProvenance } from "../lib/project-summary-provenance";
import { governIntentAdmission } from "../lib/zero-intent-admission";

const router: IRouter = Router();

const SuggestionParams = z.object({
  id: z.coerce.number().int().positive(),
});

const SuggestionIdParams = z.object({
  id: z.coerce.number().int().positive(),
  suggestionId: z.coerce.number().int().positive(),
});

router.get(
  "/projects/:id/suggestions",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SuggestionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const taskId = req.query.taskId ? parseInt(String(req.query.taskId), 10) : undefined;

    const conditions = [
      eq(projectSuggestionsTable.projectId, params.data.id),
      inArray(projectSuggestionsTable.status, ["pending", "saved"]),
    ];

    if (taskId !== undefined && !isNaN(taskId)) {
      conditions.push(eq(projectSuggestionsTable.taskId, taskId));
    }

    const rows = await db
      .select()
      .from(projectSuggestionsTable)
      .where(and(...conditions))
      .orderBy(desc(projectSuggestionsTable.createdAt))
      .limit(20);

    res.json(rows);
  },
);

router.post(
  "/projects/:id/suggestions/:suggestionId/accept",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SuggestionIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const bodyResult = z
      .object({ promptOverride: z.string().trim().min(1).optional() })
      .safeParse(req.body ?? {});
    const promptOverride = bodyResult.success ? bodyResult.data.promptOverride : undefined;

    const [suggestion] = await db
      .select()
      .from(projectSuggestionsTable)
      .where(
        and(
          eq(projectSuggestionsTable.id, params.data.suggestionId),
          eq(projectSuggestionsTable.projectId, params.data.id),
        ),
      );

    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, params.data.id));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const effectivePrompt = promptOverride ?? suggestion.prompt;

    // Mark as accepted
    await db
      .update(projectSuggestionsTable)
      .set({ status: "accepted" })
      .where(eq(projectSuggestionsTable.id, params.data.suggestionId));

    // Insert a visible user message in chat so the build feels like a manual request
    const [userMsg] = await db
      .insert(chatMessagesTable)
      .values({
        projectId: params.data.id,
        role: "user",
        content: `Build: ${suggestion.title}`,
        agentMode: project.agentMode as AgentMode,
        planMode: false,
      })
      .returning();

    // Create a task and enqueue the background refine job
    const [task] = await db
      .insert(agentTasksTable)
      .values({
        projectId: params.data.id,
        title: `Build: ${suggestion.title.slice(0, 60)}`,
        kind: "main",
        status: "planning",
        prompt: effectivePrompt,
      })
      .returning();

    if (!task) {
      res.status(500).json({ error: "Failed to create task" });
      return;
    }
    const admission = await governIntentAdmission({
      phase: "creator",
      projectId: params.data.id,
      taskId: task.id,
      requestId: `system:suggestion-build:${task.id}`,
      mutationCapable: true,
      source: "system_action",
    });

    await db
      .update(projectsTable)
      .set({
        status: "building",
        lastTaskSummary: suggestion.title.slice(0, 140),
        lastTaskSummaryProvenance: projectSummaryProvenance({
          sourceKind: "suggestion",
          sourceIdentity: `suggestion:${suggestion.id}`,
          taskId: task.id,
          actorUserId: req.userId,
          content: suggestion.title.slice(0, 140),
        }),
        updatedAt: sql`now()`,
      })
      .where(eq(projectsTable.id, params.data.id));

    enqueueJob({
      taskId: task.id,
      projectId: params.data.id,
      kind: "refine",
      userPrompt: effectivePrompt,
      agentMode: project.agentMode as AgentMode,
      intentReceiptId: admission.receiptId,
    });

    logger.info(
      { suggestionId: params.data.suggestionId, taskId: task.id },
      "Suggestion accepted — background build enqueued",
    );

    res.json({
      ok: true,
      taskId: task.id,
      userMessageId: userMsg?.id ?? null,
      suggestion: { ...suggestion, status: "accepted" },
    });
  },
);

router.post(
  "/projects/:id/suggestions/:suggestionId/save",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SuggestionIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [updated] = await db
      .update(projectSuggestionsTable)
      .set({ status: "saved" })
      .where(
        and(
          eq(projectSuggestionsTable.id, params.data.suggestionId),
          eq(projectSuggestionsTable.projectId, params.data.id),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }

    res.json(updated);
  },
);

router.post(
  "/projects/:id/suggestions/:suggestionId/dismiss",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SuggestionIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [updated] = await db
      .update(projectSuggestionsTable)
      .set({ status: "dismissed" })
      .where(
        and(
          eq(projectSuggestionsTable.id, params.data.suggestionId),
          eq(projectSuggestionsTable.projectId, params.data.id),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }

    res.json(updated);
  },
);

export default router;
