/**
 * POST /api/public-ai/tts
 *
 * Session-gated natural voice replies for Talk to Ora voice sessions.
 * This is intentionally separate from the composer microphone/dictation path:
 * it only converts Ora's text reply into high-quality audio for Voice
 * Conversation Mode.
 */
import { Router } from "express";
import { z } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { validateSession } from "../../lib/public-ai/session";
import { oraVoiceTtsLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";

const router = Router();

const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

const ttsSchema = z.object({
  text: z.string().min(1).max(4000),
  voice: z.enum(OPENAI_TTS_VOICES).optional(),
  language: z.string().max(20).optional(),
});

router.post("/public-ai/tts", oraVoiceTtsLimiter, async (req, res) => {
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

  const parsed = ttsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid voice request." });
    return;
  }

  const text = parsed.data.text.trim();
  const voice = parsed.data.voice ?? "nova";

  try {
    const response = await openai.audio.speech.create({
      model: process.env.ORA_TTS_MODEL ?? "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "mp3",
    });
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0) {
      res.status(502).json({ error: "Ora voice returned empty audio." });
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Ora-Voice", voice);
    res.send(buf);
  } catch (err) {
    logger.warn(
      { component: "ora-tts", err, voice, language: parsed.data.language ?? "auto" },
      "Ora voice TTS failed",
    );
    res.status(502).json({ error: "Ora voice failed. Please try again." });
  }
});

export default router;
