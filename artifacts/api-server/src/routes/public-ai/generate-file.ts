import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { scanUserInput } from "../../lib/public-ai/prompt";
import { generateFileFromPrompt } from "../../lib/public-ai/file-builder";

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(40000),
});

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  messages: z.array(messageItemSchema).max(20).default([]),
  format: z.enum(["csv", "xlsx", "docx", "pdf"]),
  language: z.string().max(20).optional(),
});

router.post("/public-ai/generate-file", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { message, messages, format, language } = parsed.data;

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }

  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }

  if (session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error: "You have reached the message limit for this session.",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  if (!scanUserInput(message)) {
    res.status(400).json({ error: "Message contains patterns that cannot be processed." });
    return;
  }

  const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

  try {
    const result = await generateFileFromPrompt(message, format, history, language);

    const { token, payload } = incrementMessageCount(session);
    setSessionCookie(res, token);

    logger.info(
      {
        component: "ora-generate-file",
        format,
        fileName: result.fileName,
        bytes: Buffer.from(result.fileData, "base64").length,
      },
      "File generated",
    );

    res.json({
      reply: result.reply,
      fileName: result.fileName,
      fileData: result.fileData,
      mimeType: result.mimeType,
      msgCount: payload.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
  } catch (err) {
    logger.error({ component: "ora-generate-file", format, err }, "File generation failed");
    res.status(500).json({ error: "Failed to generate file. Please try again." });
  }
});

export default router;
