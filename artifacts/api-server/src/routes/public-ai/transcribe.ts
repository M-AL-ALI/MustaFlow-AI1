/**
 * POST /api/public-ai/transcribe
 *
 * Session-gated Whisper endpoint for public Ora voice conversation mode.
 * Accepts raw audio bytes (WebM/Opus from MediaRecorder) and returns a
 * plain-text transcript via gpt-5-mini-transcribe.
 *
 * Rate-limited per IP; requires a valid ora-session cookie.
 * Max payload: 10 MB (voice clips are short; 25 MB limit applies to batch).
 */
import { Router } from "express";
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
      // If an upstream body parser (express.json) already consumed the stream
      // — e.g. a caller mislabeled the request as application/json — the "end"
      // event has already fired and would never fire again, hanging this
      // handler forever. Resolve immediately so it falls through to the
      // "Empty audio body" 400 below instead of holding the connection open.
      if (req.readableEnded) {
        resolve();
        return;
      }

      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        req.off("close", onClose);
      };
      const onData = (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_AUDIO_BYTES) {
          cleanup();
          reject(new Error("too-large"));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      // Client disconnected mid-upload: stop waiting so the handler never stalls
      // on a half-sent body. "close" before the stream finished implies an abort.
      const onAborted = () => {
        cleanup();
        reject(new Error("aborted"));
      };
      const onClose = () => {
        if (!req.readableEnded) {
          cleanup();
          reject(new Error("aborted"));
        }
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.once("aborted", onAborted);
      req.once("close", onClose);
    });
  } catch (err) {
    if (err instanceof Error && err.message === "too-large") {
      res.status(413).json({ error: "Audio clip too large. 10 MB max." });
    } else if (err instanceof Error && err.message === "aborted") {
      // Connection went away — nothing to respond to, but log for visibility.
      req.log.warn("public-ai/transcribe: client aborted before body completed");
      if (!res.headersSent) res.status(400).json({ error: "Upload interrupted." });
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
    const { speechToText } = await import("@workspace/integrations-openai-ai-server/audio");
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
