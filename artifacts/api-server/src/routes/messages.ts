import { Router, type IRouter } from "express";
import { asc, eq, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  type ChatMessage,
} from "@workspace/db";
import {
  ListMessagesParams,
  ListMessagesResponse,
  SendMessageParams,
  SendMessageBody,
  SendMessageResponse,
} from "@workspace/api-zod";
import {
  generateAssistantReply,
  generatePlan,
  type AgentMode,
  type ChatHistoryItem,
} from "../lib/ai";

const router: IRouter = Router();

router.get("/projects/:id/messages", async (req, res): Promise<void> => {
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
});

router.post("/projects/:id/messages", async (req, res): Promise<void> => {
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

  // Save user message
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

  // Build history (exclude the message we just inserted)
  const priorMessages: ChatMessage[] = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.projectId, project.id))
    .orderBy(asc(chatMessagesTable.createdAt));

  const history: ChatHistoryItem[] = priorMessages
    .filter((m) => m.id !== userMessage.id)
    .slice(-20)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content,
    }));

  let assistantContent: string;
  let plan: Record<string, unknown> | null = null;

  if (planMode) {
    const result = await generatePlan(
      project.name,
      project.kind,
      history,
      content,
      mode,
    );
    assistantContent = result.text;
    plan = result.plan;
  } else {
    assistantContent = await generateAssistantReply(
      project.name,
      project.kind,
      history,
      content,
      mode,
    );
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

  // Bump project updatedAt + last summary
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
});

export default router;
