import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { scanUserInput } from "../../lib/public-ai/prompt";
import { buildCarriedDocumentContext } from "../../lib/public-ai/carried-docs";

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
  // IDs of files the user uploaded earlier this conversation. When present we
  // re-hydrate their real content so creation extracts/transforms actual data
  // instead of fabricating it.
  documentRefs: z.array(z.string().uuid()).max(5).default([]),
});

router.post("/public-ai/generate-file", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { message, messages, format, language, documentRefs } = parsed.data;

  if (isKillSwitchActive("file_generation")) {
    res.status(503).json(killSwitchBody("file_generation"));
    return;
  }

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
  // side-effect-free read, so it can be signaled early; only the authed rolling-window
  // quota is RESERVED (consumed), and that reservation is deferred until after
  // cheap validation so rejected requests never consume a user's allowance.
  const [{ resolveAuthedOraUser }, { consumeOraQuota, refundOraQuota, oraMessageFields }] =
    await Promise.all([
      import("../../lib/public-ai/authed-user"),
      import("../../lib/public-ai/ora-usage"),
    ]);
  const authed = await resolveAuthedOraUser(req);
  if (!authed && session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error: "You have reached the message limit for this session.",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  // ── Daily spend cap (global + per-IP anonymous) ─────────────────────────
  {
    const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
    const capResult = await checkOraSpendCapAsync(
      req,
      "file_generation",
      authed?.userId ?? null,
      authed?.tier ?? "anonymous",
    );
    if (!capResult.allowed) {
      res.status(429).json({
        error: capResult.message,
        limitType: capResult.limitType,
        upgradeAvailable: capResult.upgradeAvailable,
        resetAt: capResult.resetAt,
        retryAfter: capResult.retryAfter,
      });
      return;
    }
  }

  if (!scanUserInput(message)) {
    res.status(400).json({ error: "Message contains patterns that cannot be processed." });
    return;
  }

  // File generation draws on the rolling-window MESSAGE bucket. consumeOraQuota is atomic;
  // the reservation is held below and only released via refundOraQuota on failure.
  if (authed) {
    const quota = await consumeOraQuota(authed.userId, authed.tier, "message");
    if (!quota.allowed) {
      res.status(429).json({
        error: `You've used all ${quota.limit} Ora messages in your current window on your plan. Upgrade for a higher limit, or wait for your window to reset.`,
        upgradeCta: true,
        msgCount: quota.used,
        msgLimit: quota.limit,
        resetsAt: quota.resetsAt,
      });
      return;
    }
  }

  const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

  // Re-hydrate any uploaded documents/datasets so the file is built from the
  // user's real data. Empty when nothing resolves (expired/foreign refs); in
  // that case generation falls back to its non-source-data behavior.
  const carriedDocs = await buildCarriedDocumentContext(
    documentRefs,
    session.sessionId,
    message,
    authed?.userId ?? null,
  );
  const filePrompt = carriedDocs ? `${message}\n\n${carriedDocs}` : message;
  const hasSourceData = carriedDocs.length > 0;

  let FileGenerationErrorCtor:
    | (typeof import("../../lib/public-ai/file-builder"))["FileGenerationError"]
    | null = null;
  try {
    const fileBuilder = await import("../../lib/public-ai/file-builder");
    const { tryApplyLayoutPreservingFileEdit } =
      await import("../../lib/public-ai/office-layout-edit");
    FileGenerationErrorCtor = fileBuilder.FileGenerationError;
    const result =
      (await tryApplyLayoutPreservingFileEdit({
        message,
        format,
        documentRefs,
        sessionId: session.sessionId,
        userId: authed?.userId ?? null,
        subscriptionTier: authed?.tier ?? null,
      })) ??
      (await fileBuilder.generateFileFromPrompt(
        filePrompt,
        format,
        history,
        language,
        hasSourceData,
        authed?.tier ?? null,
      ));

    // Persist to the durable asset library for signed-in users so the file
    // survives chat resets, reloads, and other devices. Best-effort — a library
    // failure must never break generation. The returned asset id is surfaced on
    // the response so the download card stays usable after reload.
    let assetId: number | null = null;
    if (authed) {
      try {
        const { persistOraAsset } = await import("../../lib/ora-assets");
        assetId = await persistOraAsset({
          userId: authed.userId,
          kind: "file",
          fileName: result.fileName,
          mimeType: result.mimeType,
          format,
          prompt: message,
          base64: result.fileData,
        });
      } catch (assetErr) {
        // Durable-library persistence is a bonus, not a requirement. A failure
        // here (DB/R2/library outage) must never break file creation: keep
        // assetId null and still return the freshly generated inline bytes, which
        // remain downloadable for this session. Do NOT fall through to the outer
        // catch (that refunds quota and 500s a file the user actually received).
        logger.warn(
          { component: "ora-generate-file", format, err: assetErr },
          "Durable asset persistence failed; returning inline file without assetId",
        );
      }
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
      ...(assetId != null ? { assetId } : {}),
      ...usage,
    });
  } catch (err) {
    if (authed) await refundOraQuota(authed.userId, "message");
    logger.error({ component: "ora-generate-file", format, err }, "File generation failed");
    // FileGenerationError carries a user-safe message (e.g. the model lost the
    // attached data) — surface it instead of the generic 500 fallback.
    if (FileGenerationErrorCtor && err instanceof FileGenerationErrorCtor) {
      res.status(422).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Failed to generate file. Please try again." });
    }
  }
});

export default router;
