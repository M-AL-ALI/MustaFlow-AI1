import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
  projectVersionsTable,
} from "@workspace/db";
import { GetRecentActivityResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/activity", async (_req, res): Promise<void> => {
  const [messages, tasks, versions, projects] = await Promise.all([
    db
      .select({
        id: chatMessagesTable.id,
        projectId: chatMessagesTable.projectId,
        content: chatMessagesTable.content,
        role: chatMessagesTable.role,
        createdAt: chatMessagesTable.createdAt,
        projectName: projectsTable.name,
      })
      .from(chatMessagesTable)
      .leftJoin(projectsTable, eq(projectsTable.id, chatMessagesTable.projectId))
      .orderBy(desc(chatMessagesTable.createdAt))
      .limit(15),
    db
      .select({
        id: agentTasksTable.id,
        projectId: agentTasksTable.projectId,
        title: agentTasksTable.title,
        status: agentTasksTable.status,
        createdAt: agentTasksTable.createdAt,
        projectName: projectsTable.name,
      })
      .from(agentTasksTable)
      .leftJoin(projectsTable, eq(projectsTable.id, agentTasksTable.projectId))
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(15),
    db
      .select({
        id: projectVersionsTable.id,
        projectId: projectVersionsTable.projectId,
        label: projectVersionsTable.label,
        createdAt: projectVersionsTable.createdAt,
        projectName: projectsTable.name,
      })
      .from(projectVersionsTable)
      .leftJoin(projectsTable, eq(projectsTable.id, projectVersionsTable.projectId))
      .orderBy(desc(projectVersionsTable.createdAt))
      .limit(15),
    db.select().from(projectsTable).orderBy(desc(projectsTable.createdAt)).limit(10),
  ]);

  const items = [
    ...messages.map((m) => ({
      id: `msg-${m.id}`,
      projectId: m.projectId,
      projectName: m.projectName ?? "Untitled project",
      kind: "message" as const,
      summary:
        m.role === "user"
          ? `You: ${m.content.slice(0, 100)}`
          : `NabuFlow: ${m.content.slice(0, 100)}`,
      createdAt: m.createdAt,
    })),
    ...tasks.map((t) => ({
      id: `task-${t.id}`,
      projectId: t.projectId,
      projectName: t.projectName ?? "Untitled project",
      kind: "task" as const,
      summary: `${t.title} — ${t.status}`,
      createdAt: t.createdAt,
    })),
    ...versions.map((v) => ({
      id: `ver-${v.id}`,
      projectId: v.projectId,
      projectName: v.projectName ?? "Untitled project",
      kind: "version" as const,
      summary: `Saved version "${v.label}"`,
      createdAt: v.createdAt,
    })),
    ...projects.map((p) => ({
      id: `prj-${p.id}`,
      projectId: p.id,
      projectName: p.name,
      kind: "project" as const,
      summary: `Created project "${p.name}"`,
      createdAt: p.createdAt,
    })),
  ]
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, 25);

  res.json(GetRecentActivityResponse.parse(items));
});

export default router;
