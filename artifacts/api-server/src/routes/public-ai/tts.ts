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
import OpenAI from "openai";
import { validateSession } from "../../lib/public-ai/session";
import { oraVoiceTtsLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";

const router = Router();

// Talk to Ora voice replies use OpenAI's POST /audio/speech endpoint, which the
// Replit AI-integrations proxy does not support ("INVALID_ENDPOINT"). Route TTS
// through a direct OpenAI client (OPENAI_API_KEY); every other Ora call still
// goes through the proxy. Constructed lazily so the route degrades gracefully
// (503) when the key is absent instead of throwing at import time.
let directTtsClient: OpenAI | null = null;
function getTtsClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!directTtsClient) {
    directTtsClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return directTtsClient;
}

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

  const client = getTtsClient();
  if (!client) {
    logger.warn({ component: "ora-tts" }, "OPENAI_API_KEY missing — Ora voice TTS unavailable");
    res.status(503).json({ error: "Voice replies are not configured." });
    return;
  }

  try {
    const response = await client.audio.speech.create({
      model: process.env.ORA_TTS_MODEL ?? "gpt-5-mini-tts",
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
