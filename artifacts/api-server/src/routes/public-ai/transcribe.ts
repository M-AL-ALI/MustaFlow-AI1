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
import OpenAI, { toFile } from "openai";
import { validateSession } from "../../lib/public-ai/session";
import { oraVoiceTranscribeLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";

const router = Router();

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_AUDIO_FORMATS = ["wav", "mp3", "webm", "mp4", "m4a", "ogg"] as const;
type AudioFormat = (typeof ALLOWED_AUDIO_FORMATS)[number];

const AUDIO_MIME_BY_FORMAT: Record<AudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

let directTranscribeClient: OpenAI | null = null;

function getDirectTranscribeClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!directTranscribeClient) {
    directTranscribeClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return directTranscribeClient;
}

async function directSpeechToText(
  buf: Buffer,
  format: AudioFormat,
  language?: string,
): Promise<string | null> {
  const client = getDirectTranscribeClient();
  if (!client) return null;

  const file = await toFile(buf, `ora-voice.${format}`, {
    type: AUDIO_MIME_BY_FORMAT[format],
  });
  const response = await client.audio.transcriptions.create({
    file,
    model: process.env.ORA_TRANSCRIBE_MODEL ?? "gpt-5-mini-transcribe",
    ...(language ? { language } : {}),
  });
  return response.text?.trim() ?? "";
}

router.post("/public-ai/transcribe", oraVoiceTranscribeLimiter, async (req, res) => {
  if (isKillSwitchActive("transcribe")) {
    req.resume();
    res.status(503).json(killSwitchBody("transcribe"));
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

  // ── Daily spend cap (global + per-user + per-IP anonymous) ─────────────
  // Check before reading the audio body to fail fast without consuming up to 10 MB.
  {
    try {
      const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
      const authed = await resolveAuthedOraUser(req);
      const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
      const capResult = await checkOraSpendCapAsync(
        req,
        "transcribe",
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
    } catch (err) {
      logger.warn(
        { component: "ora-transcribe", err },
        "Ora voice transcription spend-cap check failed open",
      );
    }
  }

  const formatRaw = (req.query.format as string | undefined)?.toLowerCase() ?? "webm";
  const format: AudioFormat = (ALLOWED_AUDIO_FORMATS as readonly string[]).includes(formatRaw)
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
    let text = "";
    try {
      text = await speechToText(buf, format, language);
    } catch (proxyErr) {
      logger.warn(
        { component: "ora-transcribe", err: proxyErr, bytes: total, format },
        "Ora transcription proxy failed; trying direct OpenAI fallback",
      );
      const directText = await directSpeechToText(buf, format, language);
      if (directText === null) {
        throw proxyErr;
      }
      text = directText;
    }
    if (!text.trim()) {
      res.status(502).json({ error: "Transcription returned no speech. Please try again." });
      return;
    }
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
