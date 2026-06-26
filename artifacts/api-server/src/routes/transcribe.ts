/**
 * Task #540 — Voice transcription endpoint.
 *
 * POST /transcribe
 *   Accepts raw audio bytes in the request body (e.g. WebM/Opus from MediaRecorder).
 *   Forwards to OpenAI's gpt-4o-mini-transcribe via the Replit AI integrations proxy.
 *   Returns { text } for the chat composer to drop into the user's draft.
 *
 * Limits:
 *   - 25 MB upload cap (OpenAI's whisper input limit).
 *   - Rate-limited by the existing aiBuilderLimiter (10 req/min/user).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { speechToText } from "@workspace/integrations-openai-ai-server/audio";
import { aiBuilderLimiter } from "../lib/rateLimit";

const router: IRouter = Router();

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — OpenAI Whisper limit

router.post(
  "/transcribe",
  aiBuilderLimiter,
  // We need raw bytes — body-parser's express.json won't help. Use a manual buffer collector.
  async (req: Request, res: Response) => {
    const formatRaw = (req.query.format as string | undefined)?.toLowerCase() ?? "webm";
    const ALLOWED = ["wav", "mp3", "webm", "mp4", "m4a", "ogg"] as const;
    type AudioFormat = (typeof ALLOWED)[number];
    const format: AudioFormat = (ALLOWED as readonly string[]).includes(formatRaw)
      ? (formatRaw as AudioFormat)
      : "webm";

    // Express may have already parsed the body for JSON-typed requests; the chat
    // composer always sends application/octet-stream so we read the raw stream.
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_AUDIO_BYTES) {
            reject(new Error("payload-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
    } catch (err) {
      if (err instanceof Error && err.message === "payload-too-large") {
        res.status(413).json({ error: "Audio too large. 25 MB max." });
        return;
      }
      req.log.error({ err }, "transcribe: failed to read body");
      res.status(400).json({ error: "Failed to read audio body" });
      return;
    }

    if (chunks.length === 0 || total === 0) {
      res.status(400).json({ error: "Empty audio body" });
      return;
    }

    const buf = Buffer.concat(chunks, total);
    try {
      const text = await speechToText(buf, format);
      res.json({ text });
    } catch (err) {
      req.log.error({ err, bytes: total, format }, "transcribe: OpenAI call failed");
      res.status(502).json({ error: "Transcription failed" });
    }
  },
);

export default router;
