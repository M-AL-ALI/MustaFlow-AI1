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
import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { consumeOraQuota, refundOraQuota, oraMessageFields } from "../../lib/public-ai/ora-usage";
import { persistOraAsset } from "../../lib/ora-assets";

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const bodySchema = z.object({
  message: z.string().min(1),
  messages: z.array(messageItemSchema).max(20).default([]),
  format: z.enum(["csv", "xlsx", "docx", "pdf", "pptx"]),
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

  // Resolve the signed-in Ora user up-front. The anonymous per-session cap is a
  // side-effect-free read, so it can be signaled early; only the authed daily
  // quota is RESERVED (consumed), and that reservation is deferred until after
  // cheap validation so rejected requests never consume a user's allowance.
  const authed = await resolveAuthedOraUser(req);
  if (!authed && session.msgCount >= MSG_LIMIT_VALUE) {
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

  // File generation draws on the daily MESSAGE bucket. consumeOraQuota is atomic;
  // the reservation is held below and only released via refundOraQuota on failure.
  if (authed) {
    const quota = await consumeOraQuota(authed.userId, authed.tier, "message");
    if (!quota.allowed) {
      res.status(429).json({
        error: `You've reached today's message limit (${quota.limit}/day) on your plan. Upgrade for more daily messages, or come back tomorrow.`,
        upgradeCta: true,
        msgCount: quota.used,
        msgLimit: quota.limit,
      });
      return;
    }
  }

  const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

  try {
    const result = await generateFileFromPrompt(message, format, history, language);

    // Persist to the durable asset library for signed-in users so the file
    // survives chat resets, reloads, and other devices. Best-effort.
    if (authed) {
      await persistOraAsset({
        userId: authed.userId,
        kind: "file",
        fileName: result.fileName,
        mimeType: result.mimeType,
        format,
        prompt: message,
        base64: result.fileData,
      });
    }

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

    const usage = await oraMessageFields(authed, payload.msgCount);
    res.json({
      reply: result.reply,
      fileName: result.fileName,
      fileData: result.fileData,
      mimeType: result.mimeType,
      ...usage,
    });
  } catch (err) {
    if (authed) await refundOraQuota(authed.userId, "message");
    logger.error({ component: "ora-generate-file", format, err }, "File generation failed");
    res.status(500).json({ error: "Failed to generate file. Please try again." });
  }
});

export default router;
