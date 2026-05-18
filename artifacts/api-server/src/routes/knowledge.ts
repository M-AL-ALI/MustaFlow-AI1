import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";
import {
  ListKnowledgeResponse,
  CreateKnowledgeBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/knowledge", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(knowledgeEntriesTable)
    .orderBy(desc(knowledgeEntriesTable.createdAt));
  res.json(ListKnowledgeResponse.parse(rows));
});

router.post("/knowledge", async (req, res): Promise<void> => {
  const parsed = CreateKnowledgeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(row);
});

export default router;
