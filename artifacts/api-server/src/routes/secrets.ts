import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, projectsTable, secretsTable, type Secret } from "@workspace/db";
import {
  ListSecretsParams,
  ListSecretsResponse,
  CreateSecretParams,
  CreateSecretBody,
} from "@workspace/api-zod";

function maskValue(value: string): string {
  if (value.length <= 4) return "•".repeat(8);
  return `${"•".repeat(8)}${value.slice(-4)}`;
}

function toEntry(row: Secret) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    masked: maskValue(row.valueEncrypted),
    environment: row.environment,
    createdAt: row.createdAt,
  };
}

const router: IRouter = Router();

router.get("/projects/:id/secrets", async (req, res): Promise<void> => {
  const params = ListSecretsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(secretsTable)
    .where(eq(secretsTable.projectId, params.data.id))
    .orderBy(desc(secretsTable.createdAt));
  res.json(ListSecretsResponse.parse(rows.map(toEntry)));
});

router.post("/projects/:id/secrets", async (req, res): Promise<void> => {
  const params = CreateSecretParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateSecretBody.safeParse(req.body);
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

  const [row] = await db
    .insert(secretsTable)
    .values({
      projectId: project.id,
      name: parsed.data.name,
      valueEncrypted: parsed.data.value,
      environment: parsed.data.environment,
    })
    .returning();

  if (!row) {
    res.status(500).json({ error: "Failed to save secret" });
    return;
  }

  res.status(201).json(toEntry(row));
});

export default router;
