import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, agentTasksTable, taskEventsTable, toolAuditTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { subscribeTaskEvents, type TaskEventPayload } from "../lib/event-bus";

const router: IRouter = Router();

const TERMINAL_EVENT_TYPES = new Set(["completed", "failed", "cancelled"]);

router.get(
  "/projects/:id/tasks/:taskId/events",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Verify the task exists AND belongs to this project (prevents IDOR)
    const [task] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)));

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const events = await db
      .select()
      .from(taskEventsTable)
      .where(eq(taskEventsTable.taskId, taskId))
      .orderBy(asc(taskEventsTable.createdAt));

    res.json(
      events.map((e) => ({
        id: e.id,
        taskId: e.taskId,
        eventType: e.eventType,
        message: e.message,
        filePath: e.filePath ?? null,
        createdAt: e.createdAt,
      })),
    );
  },
);

/**
 * SSE stream: GET /projects/:id/tasks/:taskId/events/stream
 *
 * Subscribe before replaying history so no events can slip through the gap.
 * Flow:
 *   1. Verify auth + task ownership (taskId must belong to projectId).
 *   2. Subscribe to the in-process event bus — live events are buffered.
 *   3. Replay all DB-persisted events; track the highest seen event id.
 *   4. Flush any buffered live events whose id is above the last replayed id.
 *   5. Stream future events; close on terminal ("completed" | "failed").
 */
router.get(
  "/projects/:id/tasks/:taskId/events/stream",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Verify the task exists AND belongs to this project (prevents IDOR)
    const [task] = await db
      .select({ id: agentTasksTable.id })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)));

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (payload: object): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // ── Step 1: Subscribe FIRST to buffer events that arrive during replay ──
    const liveBuffer: TaskEventPayload[] = [];
    let replayDone = false;
    let streamClosed = false;

    const unsubscribe = subscribeTaskEvents(taskId, (payload) => {
      if (streamClosed) return;
      if (!replayDone) {
        liveBuffer.push(payload);
        return;
      }
      write(payload);
      if (TERMINAL_EVENT_TYPES.has(payload.eventType)) {
        streamClosed = true;
        res.end();
      }
    });

    // ── Step 2: Replay DB history ───────────────────────────────────────────
    const existing = await db
      .select()
      .from(taskEventsTable)
      .where(eq(taskEventsTable.taskId, taskId))
      .orderBy(asc(taskEventsTable.createdAt));

    let lastReplayedId = 0;
    let sawTerminal = false;

    for (const e of existing) {
      write({
        id: e.id,
        taskId: e.taskId,
        eventType: e.eventType,
        message: e.message,
        filePath: e.filePath ?? null,
        createdAt: e.createdAt,
      });
      if (e.id > lastReplayedId) lastReplayedId = e.id;
      if (TERMINAL_EVENT_TYPES.has(e.eventType)) sawTerminal = true;
    }

    // ── Step 3: Flush buffered live events that weren't in the DB snapshot ──
    replayDone = true;

    for (const payload of liveBuffer) {
      if (payload.id <= lastReplayedId) continue; // already replayed
      if (streamClosed) break;
      write(payload);
      if (TERMINAL_EVENT_TYPES.has(payload.eventType)) {
        sawTerminal = true;
      }
    }

    if (sawTerminal) {
      streamClosed = true;
      unsubscribe();
      res.end();
      return;
    }

    req.on("close", () => {
      streamClosed = true;
      unsubscribe();
    });
  },
);

/**
 * GET /projects/:id/tasks/:taskId/trace
 *
 * Returns the agentLoop trace from agent_tasks.report.agentLoop plus matching
 * tool_audit rows (blocked commands) for security review. Loads on demand —
 * not included in the task list response.
 */
router.get(
  "/projects/:id/tasks/:taskId/trace",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(projectId) || !Number.isFinite(taskId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [task] = await db
      .select({ id: agentTasksTable.id, report: agentTasksTable.report })
      .from(agentTasksTable)
      .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)));

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const auditRows = await db
      .select()
      .from(toolAuditTable)
      .where(eq(toolAuditTable.taskId, taskId))
      .orderBy(asc(toolAuditTable.createdAt));

    const agentLoop = task.report?.agentLoop ?? null;

    res.json({
      agentLoop,
      toolAudit: auditRows.map((r) => ({
        id: r.id,
        toolName: r.toolName,
        stack: r.stack ?? null,
        argv: r.argv,
        exitCode: r.exitCode ?? null,
        stdoutTail: r.stdoutTail ?? null,
        stderrTail: r.stderrTail ?? null,
        durationMs: r.durationMs,
        blocked: r.blocked,
        blockReason: r.blockReason ?? null,
        policyStrictness: r.policyStrictness,
        createdAt: r.createdAt,
      })),
    });
  },
);

export default router;
