import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, oraTranscriptsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

const generatedFileSchema = z
  .object({
    fileName: z.string(),
    fileData: z.string().optional(),
    mimeType: z.string(),
    format: z.string(),
  })
  .transform(({ fileData: _fileData, ...rest }) => rest);

const datasetResultSchema = z
  .object({
    summary: z.string().optional(),
    columnCount: z.number().optional(),
    rowCount: z.number().optional(),
    truncated: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .transform(({ summary, columnCount, rowCount, truncated }) => ({
    summary,
    columnCount,
    rowCount,
    truncated,
  }));

const sourceSchema = z.object({
  title: z.string().max(500),
  url: z.string().max(2000),
});

const imageSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500).optional(),
  source: z.string().max(2000).optional(),
});

const videoSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500).optional(),
  thumbnailUrl: z.string().max(2000).optional(),
});

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32000),
  handoffCta: z.boolean().optional(),
  datasetResult: datasetResultSchema.optional(),
  messageKind: z.enum(["image-analysis", "document-analysis"]).optional(),
  suggestions: z.array(z.string()).optional(),
  generatedFile: generatedFileSchema.optional(),
  hadAttachment: z.boolean().optional(),
  // Mirror ora-conversations.ts: persist the upload's display metadata so the
  // attachment chip survives reload (never the file bytes).
  attachment: z
    .object({
      filename: z.string().max(300),
      fileType: z.string().max(120),
      isImage: z.boolean().optional(),
      isDataset: z.boolean().optional(),
    })
    .optional(),
  editedFrom: z.boolean().optional(),
  // Mirror the conversation schema so the anonymous/legacy transcript store
  // restores citations, inline images, and memory chips faithfully too.
  sources: z.array(sourceSchema).max(20).optional(),
  // Web-found media (real images shown inline, video link cards) — persisted so
  // they survive reload, mirroring ora-conversations.ts.
  images: z.array(imageSchema).max(8).optional(),
  videos: z.array(videoSchema).max(6).optional(),
  imageUrl: z.string().max(4000).optional(),
  imageId: z.number().int().optional(),
  editInstruction: z.string().max(2000).optional(),
  memorySaveCandidate: z.string().max(400).optional(),
  memorySaveCandidateConfidence: z.enum(["high", "low"]).optional(),
  memorySaveCandidateSensitive: z.boolean().optional(),
  memorySaved: z.boolean().optional(),
  // Mirror ora-conversations.ts: persist which saved memories shaped a reply so
  // the "based on your saved memories" indicator survives reload.
  memoriesUsed: z
    .array(z.object({ id: z.number().int(), title: z.string().max(200) }))
    .max(30)
    .optional(),
});

const saveBodySchema = z.object({
  messages: z.array(messageSchema).max(100),
});

const MAX_STORED = 100;
const MAX_PAYLOAD_BYTES = 256_000;

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

  const payloadSize = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    res.status(413).json({
      error: `Transcript payload too large (${payloadSize} bytes). Maximum allowed is ${MAX_PAYLOAD_BYTES} bytes after stripping.`,
    });
    return;
  }

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
