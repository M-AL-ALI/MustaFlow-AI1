import { Router, type IRouter } from "express";
import { asc, eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
} from "@workspace/db";
import {
  ListMessagesParams,
  ListMessagesResponse,
  SendMessageParams,
  SendMessageBody,
  SendMessageResponse,
} from "@workspace/api-zod";
import { type AgentMode } from "../lib/ai";
import { runPlanPipeline } from "../lib/builder";
import { requireProjectOwnership } from "../lib/auth";
import { enqueueJob, runJob } from "../lib/jobs";

const router: IRouter = Router();

router.get(
  "/projects/:id/messages",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = ListMessagesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const rows = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.projectId, params.data.id))
      .orderBy(asc(chatMessagesTable.createdAt));
    res.json(ListMessagesResponse.parse(rows));
  },
);

router.post(
  "/projects/:id/messages",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const params = SendMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
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

    const { content, agentMode, planMode } = parsed.data;
    const mode = agentMode as AgentMode;
    const runInBackground = Boolean(parsed.data.background);

    // Save user message first
    const [userMessage] = await db
      .insert(chatMessagesTable)
      .values({
        projectId: project.id,
        role: "user",
        content,
        agentMode: mode,
        planMode,
      })
      .returning();
    if (!userMessage) {
      res.status(500).json({ error: "Failed to save message" });
      return;
    }

    let assistantContent: string;
    let plan: Record<string, unknown> | null = null;

    if (planMode) {
      const result = await runPlanPipeline({
        projectName: project.name,
        projectKind: project.kind,
        userPrompt: content,
        agentMode: mode,
      });
      assistantContent = result.summary;
      plan = result.plan;
    } else {
      // Determine if this is an initial build or a refinement
      const [existing] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(
          sql`(select 1 from project_files where project_id = ${project.id} limit 1) as f`,
        );
      const hasFiles = (existing?.c ?? 0) > 0;
      const kind = hasFiles ? "refine" : "build";

      // Create a task row to track the work
      const [task] = await db
        .insert(agentTasksTable)
        .values({
          projectId: project.id,
          title:
            kind === "build"
              ? `Build: ${content.slice(0, 60)}`
              : `Change: ${content.slice(0, 60)}`,
          kind: runInBackground ? "background" : "main",
          status: "planning",
          prompt: content,
        })
        .returning();
      if (!task) {
        res.status(500).json({ error: "Failed to enqueue task" });
        return;
      }

      if (runInBackground) {
        enqueueJob({
          taskId: task.id,
          projectId: project.id,
          kind,
          userPrompt: content,
          agentMode: mode,
        });
        assistantContent = `I've queued this in the Background Agent. Task #${task.id} is running and I'll post the report back here when it's done.`;
        plan = { kind: "task-queued", taskId: task.id } as unknown as Record<
          string,
          unknown
        >;
      } else {
        // Synchronous main-agent run so the user sees the result immediately
        await runJob({
          taskId: task.id,
          projectId: project.id,
          kind,
          userPrompt: content,
          agentMode: mode,
        });

        const [refreshed] = await db
          .select()
          .from(agentTasksTable)
          .where(eq(agentTasksTable.id, task.id));
        assistantContent =
          refreshed?.result ??
          (kind === "build"
            ? "I generated your app. Open the Preview tab to see it."
            : "I applied your changes. Refresh the Preview tab.");
        plan = refreshed?.report
          ? ({
              kind: "report",
              report: refreshed.report,
              taskId: task.id,
            } as unknown as Record<string, unknown>)
          : ({ kind: "task-done", taskId: task.id } as unknown as Record<
              string,
              unknown
            >);
      }
    }

    const [assistantMessage] = await db
      .insert(chatMessagesTable)
      .values({
        projectId: project.id,
        role: "assistant",
        content: assistantContent,
        agentMode: mode,
        planMode,
        plan: plan ?? undefined,
      })
      .returning();
    if (!assistantMessage) {
      res.status(500).json({ error: "Failed to save assistant message" });
      return;
    }

    await db
      .update(projectsTable)
      .set({
        updatedAt: sql`now()`,
        lastTaskSummary: content.slice(0, 140),
        agentMode: mode,
      })
      .where(eq(projectsTable.id, project.id));

    res.json(
      SendMessageResponse.parse({
        userMessage,
        assistantMessage,
      }),
    );
  },
);

export default router;
