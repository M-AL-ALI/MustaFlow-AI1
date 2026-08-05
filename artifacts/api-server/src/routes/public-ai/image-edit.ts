import { Router } from "express";
import { z } from "zod";
import {
  incrementMessageCount,
  setSessionCookie,
  validateSession,
} from "../../lib/public-ai/session";
import { getImage } from "../../lib/public-ai/image-store";
import { scanUserInput } from "../../lib/public-ai/prompt";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { oraActivityStep } from "@workspace/ora-contracts";
import { logger } from "../../lib/logger";

const router = Router();

const bodySchema = z.object({
  imageRef: z.string().uuid(),
  message: z.string().min(1).max(4_000),
});

async function durableImageUrl(url: string, fallbackMimeType: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Edited image download failed (${response.status})`);
  const mimeType = response.headers.get("content-type") || fallbackMimeType || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Edited image download returned no bytes");
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

router.post("/public-ai/image-edit", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid image edit request." });
    return;
  }
  if (isKillSwitchActive("image_generation")) {
    res.status(503).json(killSwitchBody("image_generation"));
    return;
  }

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  const session = sessionToken ? validateSession(sessionToken) : null;
  if (!session) {
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }
  if (!scanUserInput(parsed.data.message)) {
    res.status(400).json({ error: "Message contains patterns that cannot be processed." });
    return;
  }

  const image = getImage(parsed.data.imageRef, session.sessionId);
  if (!image) {
    res.status(404).json({
      error: "This image is no longer available. Please upload it again.",
    });
    return;
  }

  const [{ resolveAuthedOraUser }, { consumeOraQuota, refundOraQuota, oraMessageFields }] =
    await Promise.all([
      import("../../lib/public-ai/authed-user"),
      import("../../lib/public-ai/ora-usage"),
    ]);
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Sign in to edit uploaded images." });
    return;
  }

  const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
  const cap = await checkOraSpendCapAsync(req, "image_generation", authed.userId, authed.tier);
  if (!cap.allowed) {
    res.status(429).json({
      error: cap.message,
      limitType: cap.limitType,
      upgradeAvailable: cap.upgradeAvailable,
      resetAt: cap.resetAt,
      retryAfter: cap.retryAfter,
    });
    return;
  }

  const quota = await consumeOraQuota(authed.userId, authed.tier, "image");
  if (!quota.allowed) {
    res.status(429).json({
      error: `You've used all ${quota.limit} Ora images in your current window.`,
      upgradeCta: true,
      used: quota.used,
      limit: quota.limit,
      resetsAt: quota.resetsAt,
    });
    return;
  }

  try {
    const { editImage, isImageProviderConfigured } = await import("../../lib/image-provider");
    if (!isImageProviderConfigured()) {
      throw new Error("image-edit-provider-unavailable");
    }
    const result = await editImage({
      imageBuffer: Buffer.from(image.base64, "base64"),
      instruction: parsed.data.message,
      quality: "standard",
      subscriptionTier: authed.tier,
    });
    const imageUrl = await durableImageUrl(result.openaiUrl, result.mimeType);
    const { token, payload } = incrementMessageCount(session);
    setSessionCookie(res, token);
    const usage = await oraMessageFields(authed, payload.msgCount);

    res.json({
      reply: "Here's the edited image.",
      imageUrl,
      editInstruction: parsed.data.message,
      activity: [oraActivityStep("image-generation", "ok")],
      ...usage,
    });
  } catch (err) {
    await refundOraQuota(authed.userId, "image");
    logger.error({ component: "ora-uploaded-image-edit", err }, "Uploaded image edit failed");
    res.status(500).json({
      error: "I couldn't edit that image. No edited image was created. Please try again.",
      activity: [oraActivityStep("image-generation", "fail")],
    });
  }
});

export default router;
