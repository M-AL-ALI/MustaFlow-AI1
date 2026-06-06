/**
 * POST /api/public-ai/transcribe
 *
 * Session-gated Whisper endpoint for public Ora voice conversation mode.
 * Accepts raw audio bytes (WebM/Opus from MediaRecorder) and returns a
 * plain-text transcript via gpt-4o-mini-transcribe.
 *
 * Rate-limited per IP; requires a valid ora-session cookie.
 * Max payload: 10 MB (voice clips are short; 25 MB limit applies to batch).
 */
import { Router } from "express";
import { speechToText } from "@workspace/integrations-openai-ai-server/audio";
import { validateSession } from "../../lib/public-ai/session";
import { oraVoiceTranscribeLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";

const router = Router();

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

router.post("/public-ai/transcribe", oraVoiceTranscribeLimiter, async (req, res) => {
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

  const formatRaw = (req.query.format as string | undefined)?.toLowerCase() ?? "webm";
  const ALLOWED = ["wav", "mp3", "webm", "mp4", "m4a", "ogg"] as const;
  type AudioFormat = (typeof ALLOWED)[number];
  const format: AudioFormat = (ALLOWED as readonly string[]).includes(formatRaw)
    ? (formatRaw as AudioFormat)
    : "webm";

  // Optional ISO-639-1 language hint (e.g. "ar", "en") forwarded from the client.
  // "auto" is treated as "let Whisper detect" — we don't pass it to the API.
  const langRaw = (req.query.lang as string | undefined)?.toLowerCase().trim();
  const language =
    langRaw && langRaw !== "auto" && /^[a-z]{2,3}$/.test(langRaw) ? langRaw : undefined;

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_AUDIO_BYTES) {
          reject(new Error("too-large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", resolve);
      req.on("error", reject);
    });
  } catch (err) {
    if (err instanceof Error && err.message === "too-large") {
      res.status(413).json({ error: "Audio clip too large. 10 MB max." });
    } else {
      req.log.error({ err }, "public-ai/transcribe: failed to read body");
      res.status(400).json({ error: "Failed to read audio." });
    }
    return;
  }

  if (chunks.length === 0 || total === 0) {
    res.status(400).json({ error: "Empty audio body." });
    return;
  }

  const buf = Buffer.concat(chunks, total);

  try {
    const text = await speechToText(buf, format, language);
    logger.info(
      {
        component: "ora-transcribe",
        bytes: total,
        format,
        language: language ?? "auto",
      },
      "Whisper transcription complete",
    );
    res.json({ text });
  } catch (err) {
    req.log.error({ err, bytes: total, format }, "public-ai/transcribe: Whisper call failed");
    res.status(502).json({ error: "Transcription failed. Please try again." });
  }
});

export default router;
