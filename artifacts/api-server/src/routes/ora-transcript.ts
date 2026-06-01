import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, oraTranscriptsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

const generatedFileSchema = z.object({
  fileName: z.string(),
  fileData: z.string(),
  mimeType: z.string(),
  format: z.string(),
});

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32000),
  handoffCta: z.boolean().optional(),
  datasetResult: z.unknown().optional(),
  messageKind: z.enum(["image-analysis", "document-analysis"]).optional(),
  suggestions: z.array(z.string()).optional(),
  generatedFile: generatedFileSchema.optional(),
  hadAttachment: z.boolean().optional(),
  editedFrom: z.boolean().optional(),
});

const saveBodySchema = z.object({
  messages: z.array(messageSchema).max(200),
});

const MAX_STORED = 100;

router.get("/ora/transcript", async (req, res) => {
  const userId = req.userId!;
  try {
    const [row] = await db
      .select()
      .from(oraTranscriptsTable)
      .where(eq(oraTranscriptsTable.userId, userId));

    res.json({ messages: row?.messages ?? [] });
  } catch (err) {
    logger.error({ component: "ora-transcript", err }, "Failed to fetch transcript");
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

router.post("/ora/transcript", async (req, res) => {
  const userId = req.userId!;
  const parsed = saveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const messages = parsed.data.messages.slice(-MAX_STORED);

  try {
    await db
      .insert(oraTranscriptsTable)
      .values({ userId, messages })
      .onConflictDoUpdate({
        target: oraTranscriptsTable.userId,
        set: { messages, updatedAt: new Date() },
      });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-transcript", err }, "Failed to save transcript");
    res.status(500).json({ error: "Failed to save conversation" });
  }
});

router.delete("/ora/transcript", async (req, res) => {
  const userId = req.userId!;
  try {
    await db.delete(oraTranscriptsTable).where(eq(oraTranscriptsTable.userId, userId));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-transcript", err }, "Failed to clear transcript");
    res.status(500).json({ error: "Failed to clear conversation" });
  }
});

export default router;
