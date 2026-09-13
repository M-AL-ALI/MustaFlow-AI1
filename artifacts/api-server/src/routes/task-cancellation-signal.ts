import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { agentTasksTable, db } from "@workspace/db";
import { CancelTaskParams } from "@workspace/api-zod";
import { requireProjectOwnership } from "../lib/auth";
import { cancelActiveJob } from "../lib/jobs";
import { hasConfirmedUserStop } from "../lib/confirmed-user-stop";

const router: IRouter = Router();

/**
 * An owner may signal an active build before waiting for its lifecycle lock.
 * This only aborts local work. The existing cancel route still acquires the
 * lifecycle fence, rechecks the task, and persists the terminal/refund receipt.
 * Never acknowledge cancellation here or perform database/provider mutations.
 */
router.post(
  "/projects/:id/tasks/:taskId/cancel",
  requireProjectOwnership,
  async (req, res, next): Promise<void> => {
    const params = CancelTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [task] = await db
      .select({
        id: agentTasksTable.id,
        projectId: agentTasksTable.projectId,
        status: agentTasksTable.status,
        intentReceiptId: agentTasksTable.intentReceiptId,
        terminal: agentTasksTable.terminal,
      })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.id, params.data.taskId),
          eq(agentTasksTable.projectId, params.data.id),
        ),
      )
      .limit(1);
    if (!task || task.id !== params.data.taskId || task.projectId !== params.data.id) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (hasConfirmedUserStop(task, { projectId: params.data.id, taskId: params.data.taskId })) {
      // A replay still crosses the lifecycle fence and the final ownership check.
      next();
      return;
    }
    if (!["queued", "building", "planning"].includes(task.status)) {
      res.status(409).json({
        error: `Task is already in state "${task.status}" and cannot be canceled`,
      });
      return;
    }
    if (!Number.isInteger(task.intentReceiptId) || (task.intentReceiptId ?? 0) < 1) {
      res.status(409).json({ error: "This older task cannot be canceled safely." });
      return;
    }
    cancelActiveJob(task.id);
    next();
  },
);

export default router;
