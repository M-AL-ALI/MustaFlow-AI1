import {
  db,
  projectsTable,
  chatMessagesTable,
  agentTasksTable,
  projectVersionsTable,
  knowledgeEntriesTable,
  pool,
} from "@workspace/db";

async function main() {
  const existing = await db.select().from(projectsTable);
  if (existing.length > 0) {
    console.log(`Skipping seed — ${existing.length} projects already exist.`);
    return;
  }

  const ownerId = process.env.SEED_OWNER_ID?.trim();
  if (!ownerId) {
    throw new Error("SEED_OWNER_ID is required when creating sample projects");
  }

  const defaultWorkspaceRows = await pool.query<{ id: number }>(
    `SELECT workspace.id
       FROM workspaces AS workspace
       JOIN workspace_members AS member ON member.workspace_id = workspace.id
      WHERE member.user_id = $1
        AND member.role = 'owner'
        AND workspace.deleted_at IS NULL
      ORDER BY workspace.created_at ASC, workspace.id ASC
      LIMIT 1`,
    [ownerId],
  );
  const defaultWorkspace = defaultWorkspaceRows.rows[0];
  if (!defaultWorkspace) {
    throw new Error("SEED_OWNER_ID has no active owner workspace");
  }

  const seeds = [
    {
      name: "Aurora Notes",
      description: "A calm, focused notes app with daily reflections and AI summaries.",
      kind: "web" as const,
      status: "building" as const,
      lastTaskSummary: "Drafted the inbox layout and quick-capture flow",
    },
    {
      name: "Pulse Run Club",
      description:
        "iOS social fitness app for casual runners — routes, streaks, and friendly leaderboards.",
      kind: "mobile-ios" as const,
      status: "draft" as const,
      lastTaskSummary: "Set up the onboarding screens and run-tracking shell",
    },
    {
      name: "Cedar Bookings",
      description: "A small-business booking dashboard with calendar, customers, and payments.",
      kind: "dashboard" as const,
      status: "testing" as const,
      lastTaskSummary: "Connected the calendar to a sample customer list",
    },
  ];

  for (const seed of seeds) {
    const [p] = await db
      .insert(projectsTable)
      .values({ ...seed, ownerId, workspaceId: defaultWorkspace.id })
      .returning();
    if (!p) continue;
    await db.insert(chatMessagesTable).values([
      {
        projectId: p.id,
        role: "user",
        content: `Let's start building ${p.name}. ${p.description}`,
        agentMode: "eco",
        planMode: false,
      },
      {
        projectId: p.id,
        role: "assistant",
        content: `Got it. I'll get a clean foundation in place for "${p.name}" and we'll iterate from there. Tell me which screen you'd like to see first.`,
        agentMode: "eco",
        planMode: false,
      },
    ]);
    await db.insert(agentTasksTable).values({
      projectId: p.id,
      title: `Bootstrap "${p.name}" foundation`,
      kind: "main",
      status: "completed",
      result: "Initial scaffolding generated and reviewed.",
      completedAt: new Date(),
    });
    await db.insert(projectVersionsTable).values({
      projectId: p.id,
      label: "v0.1 — first draft",
      note: "Initial scaffolding",
    });
  }

  await db.insert(knowledgeEntriesTable).values([
    {
      title: "Always confirm the goal before generating a plan",
      content: "Restating the user's idea in one sentence prevents off-target builds.",
      category: "pattern",
    },
    {
      title: "Mask secrets in API responses",
      content:
        "Server never returns raw secret values — only a masked preview with the last four characters.",
      category: "lesson",
    },
  ]);

  console.log("Seeded MustaFlow AI sample data.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
