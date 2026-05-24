import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, agentTasksTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { listPendingPromptsForTask, respondToPrompt } from "../lib/agent-prompts";

const router: IRouter = Router();

router.get(
  "/projects/:id/tasks/:taskId/prompts",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [task] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ prompts: listPendingPromptsForTask(taskId) });
  },
);

router.post(
  "/projects/:id/tasks/:taskId/prompts/:promptId/respond",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    const promptId = String(req.params.promptId ?? "");
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId) || !promptId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [task] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const body = (req.body ?? {}) as { response?: unknown };
    if (!body.response || typeof body.response !== "object" || Array.isArray(body.response)) {
      res.status(400).json({ error: "Missing { response } object" });
      return;
    }
    const r = respondToPrompt(
      promptId,
      taskId,
      projectId,
      body.response as Record<string, unknown>,
    );
    if (!r.ok) {
      res.status(404).json({ error: r.reason ?? "prompt not found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
