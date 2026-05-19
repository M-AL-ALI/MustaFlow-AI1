import { Router, type IRouter } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { enqueueJob } from "../lib/jobs";
import { logger } from "../lib/logger";
import { z } from "zod";
import type { AgentMode } from "../lib/ai";

const router: IRouter = Router();

const SubmitQueueBody = z.object({
  messages: z.array(z.string().min(1)).min(1).max(20),
  agentMode: z.enum(["lite", "eco", "power", "pro"]),
  planMode: z.boolean().optional().default(false),
});

const CREDIT_COST: Record<string, number> = {
  lite: 1,
  eco: 2,
  power: 5,
  pro: 10,
};

router.post(
  "/projects/:id/queue",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(String(req.params.id ?? ""), 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const parsed = SubmitQueueBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { messages, agentMode, planMode } = parsed.data;
    const mode = agentMode as AgentMode;

    const batchId = crypto.randomUUID();
    const taskIds: number[] = [];

    const [existing] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(
        sql`(select 1 from project_files where project_id = ${projectId} limit 1) as f`,
      );
    const hasFiles = (existing?.c ?? 0) > 0;

    for (let i = 0; i < messages.length; i++) {
      const content = messages[i]!;
      const kind = hasFiles || i > 0 ? "refine" : "build";

      const [userMsg] = await db
        .insert(chatMessagesTable)
        .values({
          projectId,
          role: "user",
          content,
          agentMode: mode,
          planMode: planMode ?? false,
        })
        .returning();

      if (!userMsg) {
        res.status(500).json({ error: "Failed to save message" });
        return;
      }

      const [task] = await db
        .insert(agentTasksTable)
        .values({
          projectId,
          title:
            kind === "build"
              ? `Build: ${content.slice(0, 60)}`
              : `Change: ${content.slice(0, 60)}`,
          kind: "main",
          status: i === 0 ? "planning" : "queued",
          prompt: content,
          queueBatchId: batchId,
          queueIndex: i,
        })
        .returning();

      if (!task) {
        res.status(500).json({ error: "Failed to create task" });
        return;
      }

      taskIds.push(task.id);

      if (i === 0) {
        const recentMessages = await db
          .select({
            role: chatMessagesTable.role,
            content: chatMessagesTable.content,
          })
          .from(chatMessagesTable)
          .where(eq(chatMessagesTable.projectId, projectId))
          .orderBy(asc(chatMessagesTable.createdAt));

        const conversationHistory = recentMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }))
          .slice(-8);

        enqueueJob({
          taskId: task.id,
          projectId,
          kind,
          userPrompt: content,
          agentMode: mode,
          conversationHistory,
        });
      }
    }

    const creditCost = CREDIT_COST[mode] ?? 1;
    const totalCost = creditCost * messages.length;

    await db
      .update(projectsTable)
      .set({
        updatedAt: sql`now()`,
        lastTaskSummary: messages[0]!.slice(0, 140),
        agentMode: mode,
      })
      .where(eq(projectsTable.id, projectId));

    await db.insert(chatMessagesTable).values({
      projectId,
      role: "assistant",
      content: `Queue started — ${messages.length} task${messages.length !== 1 ? "s" : ""} pending (estimated ${totalCost} credit${totalCost !== 1 ? "s" : ""}).`,
      agentMode: mode,
      planMode: false,
      plan: {
        kind: "queue-started",
        batchId,
        totalTasks: messages.length,
        taskIds,
      } as unknown as Record<string, unknown>,
    });

    res.json({ batchId, taskIds, totalTasks: messages.length });
  },
);

router.get(
  "/projects/:id/queue/:batchId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(String(req.params.id ?? ""), 10);
    const batchId = String(req.params.batchId ?? "");

    if (isNaN(projectId) || !batchId) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }

    const tasks = await db
      .select()
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.projectId, projectId),
          eq(agentTasksTable.queueBatchId, batchId),
        ),
      )
      .orderBy(asc(agentTasksTable.queueIndex));

    if (tasks.length === 0) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }

    const totalCount = tasks.length;
    const completedCount = tasks.filter((t) => t.status === "completed").length;
    const failedCount = tasks.filter((t) => t.status === "failed").length;
    const cancelledCount = tasks.filter((t) => t.status === "canceled").length;

    res.json({
      batchId,
      projectId,
      tasks,
      totalCount,
      completedCount,
      failedCount,
      cancelledCount,
    });
  },
);

router.delete(
  "/projects/:id/queue/:batchId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = parseInt(String(req.params.id ?? ""), 10);
    const batchId = String(req.params.batchId ?? "");

    if (isNaN(projectId) || !batchId) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }

    try {
      const result = await db
        .update(agentTasksTable)
        .set({ status: "canceled", completedAt: sql`now()` })
        .where(
          and(
            eq(agentTasksTable.projectId, projectId),
            eq(agentTasksTable.queueBatchId, batchId),
            eq(agentTasksTable.status, "queued"),
          ),
        )
        .returning({ id: agentTasksTable.id });

      res.json({ cancelled: result.length, batchId });
    } catch (err) {
      logger.error({ err }, "Failed to cancel queue batch");
      res.status(500).json({ error: "Failed to cancel batch" });
    }
  },
);

export default router;
