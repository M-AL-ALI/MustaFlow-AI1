/**
 * Agent Creative Pack (Task #530)
 *
 * Four media-generation tools the agent loop can invoke during a build/refine:
 *   - generate_image          — text → PNG via gpt-image-1
 *   - generate_video          — text → MP4 (graceful "not configured" stub)
 *   - generate_audio          — text → MP3 via OpenAI TTS
 *   - remove_image_background — existing PNG/JPEG in workspace → transparent PNG
 *
 * Every helper is non-throwing and returns a structured { ok, ... } payload so
 * the loop can fold the result into the model conversation. Each successful
 * call carries the raw asset as a base64 string ready to be written into the
 * project's file workspace as binary content.
 *
 * Credit accounting is handled by the caller (executeTool) via the
 * onBillableCreativeCall hook — this module never touches the DB.
 */

import { openai } from "@workspace/integrations-openai-ai-server";
import { generateImageBuffer } from "@workspace/integrations-openai-ai-server/image";
import { toFile } from "openai";
import { Buffer } from "node:buffer";
import { logger } from "./logger";

export type CreativeOk = {
  ok: true;
  base64: string;
  mimeType: string;
  bytes: number;
};

export type CreativeErr = {
  ok: false;
  error: string;
  notConfigured?: boolean;
};

export type CreativeResult = CreativeOk | CreativeErr;

const MAX_PROMPT_CHARS = 2_000;
const MAX_TTS_CHARS = 2_000; // ~30s of speech at typical TTS pacing

/** Generate a PNG image from a text prompt via OpenAI gpt-image-1. */
export async function generateImageAsset(args: {
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024";
  signal: AbortSignal;
}): Promise<CreativeResult> {
  const prompt = (args.prompt ?? "").trim().slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return { ok: false, error: "prompt is required" };
  if (args.signal.aborted) return { ok: false, error: "aborted by user" };
  try {
    const buf = await generateImageBuffer(prompt, args.size ?? "1024x1024");
    if (!buf || buf.length === 0) {
      return { ok: false, error: "image generation returned empty buffer" };
    }
    return {
      ok: true,
      base64: buf.toString("base64"),
      mimeType: "image/png",
      bytes: buf.length,
    };
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 300);
    logger.warn({ err }, "agent-creative: generate_image failed");
    return { ok: false, error: msg };
  }
}

/**
 * Synthesize speech from text via OpenAI gpt-audio (`audio.speech.create`).
 * Returns MP3 by default — the smallest broadly-playable container.
 */
export async function generateAudioAsset(args: {
  text: string;
  voice?: string;
  format?: "mp3" | "wav" | "opus";
  signal: AbortSignal;
}): Promise<CreativeResult> {
  const text = (args.text ?? "").trim().slice(0, MAX_TTS_CHARS);
  if (!text) return { ok: false, error: "text is required" };
  if (args.signal.aborted) return { ok: false, error: "aborted by user" };
  const voice = (args.voice ?? "alloy").slice(0, 40);
  const format = args.format ?? "mp3";
  try {
    const resp = await openai.audio.speech.create(
      {
        model: "gpt-5-mini-tts",
        voice,
        input: text,
        response_format: format,
      },
      { signal: args.signal },
    );
    const arr = await resp.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.length === 0) {
      return { ok: false, error: "tts returned empty audio" };
    }
    const mime = format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
    return {
      ok: true,
      base64: buf.toString("base64"),
      mimeType: mime,
      bytes: buf.length,
    };
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 300);
    logger.warn({ err }, "agent-creative: generate_audio failed");
    return { ok: false, error: msg };
  }
}

/**
 * Text-to-video generation.
 *
 * Routing:
 *   1. If `VIDEO_GENERATION_PROVIDER_URL` is set, POST `{prompt, aspectRatio,
 *      durationSeconds}` to that URL. Response must be an MP4 byte stream or
 *      a JSON `{base64}` payload. This is the production hook used when a
 *      real provider (Sora, Runway, Replicate, etc.) is wired up.
 *   2. Otherwise return a structured `notConfigured` error — matching the
 *      web_search "Brave not configured" pattern. Counted toward the
 *      per-task creative budget so the model learns not to spam it, but NOT
 *      billed (failed calls never charge credits).
 */
export async function generateVideoAsset(args: {
  prompt: string;
  aspectRatio?: "16:9" | "9:16";
  durationSeconds?: number;
  signal: AbortSignal;
}): Promise<CreativeResult> {
  const prompt = (args.prompt ?? "").trim().slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return { ok: false, error: "prompt is required" };
  if (args.signal.aborted) return { ok: false, error: "aborted by user" };

  const providerUrl = process.env.VIDEO_GENERATION_PROVIDER_URL;
  if (!providerUrl) {
    return {
      ok: false,
      notConfigured: true,
      error:
        "generate_video is not configured (set VIDEO_GENERATION_PROVIDER_URL to enable). Use generate_image plus CSS/JS animation instead.",
    };
  }

  try {
    const aspectRatio = args.aspectRatio === "9:16" ? "9:16" : "16:9";
    const durationSeconds = Math.min(8, Math.max(2, args.durationSeconds ?? 6));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.VIDEO_GENERATION_PROVIDER_TOKEN) {
      headers["authorization"] = `Bearer ${process.env.VIDEO_GENERATION_PROVIDER_TOKEN}`;
    }
    const resp = await fetch(providerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt, aspectRatio, durationSeconds }),
      signal: args.signal,
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: `video provider returned ${resp.status} ${resp.statusText}`,
      };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    let buf: Buffer;
    if (contentType.includes("application/json")) {
      const body = (await resp.json()) as { base64?: string; error?: string };
      if (!body.base64) {
        return { ok: false, error: body.error ?? "video provider returned no base64 payload" };
      }
      buf = Buffer.from(body.base64, "base64");
    } else {
      const arr = await resp.arrayBuffer();
      buf = Buffer.from(arr);
    }
    if (buf.length === 0) {
      return { ok: false, error: "video provider returned empty payload" };
    }
    return {
      ok: true,
      base64: buf.toString("base64"),
      mimeType: "video/mp4",
      bytes: buf.length,
    };
  } catch (err) {
    if (args.signal.aborted) return { ok: false, error: "aborted by user" };
    const msg = String((err as Error).message ?? err).slice(0, 300);
    logger.warn({ err }, "agent-creative: generate_video failed");
    return { ok: false, error: msg };
  }
}

/**
 * Remove the background of an existing image already present in the
 * workspace. Uses OpenAI's image edit endpoint with gpt-image-1 and the
 * "transparent" background hint. Input must be PNG or JPEG.
 */
export async function removeImageBackgroundAsset(args: {
  imageBase64: string;
  imageMimeType: string;
  filename: string;
  signal: AbortSignal;
}): Promise<CreativeResult> {
  if (args.signal.aborted) return { ok: false, error: "aborted by user" };
  const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
  if (!allowed.has(args.imageMimeType)) {
    return {
      ok: false,
      error: `unsupported image mime: ${args.imageMimeType} (need png, jpeg, or webp)`,
    };
  }
  if (!args.imageBase64) return { ok: false, error: "imageBase64 is required" };
  try {
    const buf = Buffer.from(args.imageBase64, "base64");
    const file = await toFile(buf, args.filename || "input.png", {
      type: args.imageMimeType,
    });
    const resp = await openai.images.edit(
      {
        model: "gpt-image-1",
        image: file,
        prompt:
          "Remove the background completely. Return a clean cutout with a transparent background.",
        // gpt-image-1 supports a `background: "transparent"` hint when supplied
        // by the proxy; pass it as a typed-cast option so we degrade cleanly
        // if the proxy version is older.
        ...({ background: "transparent" } as Record<string, unknown>),
      },
      { signal: args.signal },
    );
    const b64 = resp.data?.[0]?.b64_json ?? "";
    if (!b64) return { ok: false, error: "image edit returned no data" };
    const outBuf = Buffer.from(b64, "base64");
    return {
      ok: true,
      base64: b64,
      mimeType: "image/png",
      bytes: outBuf.length,
    };
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 300);
    logger.warn({ err }, "agent-creative: remove_image_background failed");
    return { ok: false, error: msg };
  }
}
