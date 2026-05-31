/**
 * Image generation provider abstraction — Phase 9A-1.
 *
 * ISOLATION: this file MUST NOT import from builder.ts, ai.ts, or any
 * builder pipeline module. It is the sole entry point for image generation
 * and uses direct OpenAI SDK calls (not the Replit AI integration proxy).
 *
 * Required env:
 *   OPENAI_IMAGE_API_KEY — direct OpenAI API key for image models (preferred)
 *   IMAGE_API_KEY        — legacy alias (still accepted)
 *   OPENAI_API_KEY       — fallback if neither image-specific key is set
 *   IMAGE_MODEL          — model override (default: gpt-image-1)
 *
 * Model families supported:
 *   gpt-image-1 / gpt-image-* / chatgpt-image-* family:
 *     - Quality:  low | medium | high
 *     - Sizes:    1024x1024 | 1536x1024 | 1024x1536
 *     - No style parameter; returns b64_json
 *   dall-e-3 (legacy, requires explicit IMAGE_MODEL=dall-e-3):
 *     - Quality:  standard | hd
 *     - Sizes:    1024x1024 | 1792x1024 | 1024x1792
 *     - style: vivid | natural; returns URL
 */
import OpenAI from "openai";
import { logger } from "./logger";

export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageQuality = "draft" | "standard" | "high";
export type ImageStyle = "vivid" | "natural";

export interface ImageGenerateOptions {
  prompt: string;
  quality?: ImageQuality;
  aspectRatio?: ImageAspectRatio;
  style?: ImageStyle;
  transparentBackground?: boolean;
}

export interface ImageGenerateResult {
  openaiUrl: string;
  revisedPrompt: string | null;
  width: number;
  height: number;
  mimeType: string;
}

/**
 * Provider abstraction — selected via IMAGE_PROVIDER env var (default: "openai").
 * Additional providers (e.g. "stability", "replicate") can be added here without
 * touching callers; each must implement ImageProvider.
 */
export interface ImageProvider {
  generate(opts: ImageGenerateOptions): Promise<ImageGenerateResult>;
  isConfigured(): boolean;
}

function getActiveProviderName(): string {
  return (process.env.IMAGE_PROVIDER ?? "openai").toLowerCase();
}

/** Returns true for gpt-image-* and chatgpt-image-* model families. */
function isGptImageFamily(model: string): boolean {
  return model.startsWith("gpt-image") || model.startsWith("chatgpt-image");
}

// ── Size resolution ───────────────────────────────────────────────────────────

type DalleSize = "1024x1024" | "1792x1024" | "1024x1792";
type GptImageSize = "1024x1024" | "1536x1024" | "1024x1536";
type AnySize = DalleSize | GptImageSize;

function resolveSize(aspectRatio: ImageAspectRatio, model: string): AnySize {
  if (isGptImageFamily(model)) {
    switch (aspectRatio) {
      case "16:9":
        return "1536x1024";
      case "9:16":
        return "1024x1536";
      default:
        return "1024x1024";
    }
  }
  // dall-e-3 legacy sizes
  switch (aspectRatio) {
    case "16:9":
      return "1792x1024";
    case "9:16":
      return "1024x1792";
    default:
      return "1024x1024";
  }
}

// ── Quality resolution ────────────────────────────────────────────────────────

type DalleQuality = "standard" | "hd";
type GptImageQuality = "low" | "medium" | "high";
type AnyQuality = DalleQuality | GptImageQuality;

function resolveQuality(quality: ImageQuality, model: string): AnyQuality {
  if (isGptImageFamily(model)) {
    switch (quality) {
      case "draft":
        return "low";
      case "standard":
        return "medium";
      case "high":
        return "high";
    }
  }
  // dall-e-3 quality values
  return quality === "high" ? "hd" : "standard";
}

function sizeToPixels(size: AnySize): { width: number; height: number } {
  const [w, h] = size.split("x").map(Number);
  return { width: w!, height: h! };
}

// ── API client ────────────────────────────────────────────────────────────────

function getClient(): OpenAI {
  const apiKey =
    process.env.OPENAI_IMAGE_API_KEY ??
    process.env.IMAGE_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "";
  if (!apiKey) {
    throw new Error("Image generation not configured: set OPENAI_IMAGE_API_KEY or OPENAI_API_KEY");
  }
  return new OpenAI({ apiKey });
}

// ── Resolve raw image from URL or base64 data URI ────────────────────────────

/**
 * The image source returned by the provider may be:
 *   - An HTTPS URL      (dall-e-3 default)
 *   - A data URI        (gpt-image-1 returns b64_json; we wrap it as data:image/png;base64,…)
 * Callers (image-storage.ts) handle both via resolveRawBuffer.
 */

// ── Main generate function ────────────────────────────────────────────────────

export async function generateImage(opts: ImageGenerateOptions): Promise<ImageGenerateResult> {
  const provider = getActiveProviderName();
  if (provider !== "openai") {
    logger.warn(
      { provider },
      "image-provider: IMAGE_PROVIDER value is not supported; only 'openai' is available — falling back to openai",
    );
  }

  const { prompt, quality = "standard", aspectRatio = "1:1", style = "vivid" } = opts;

  // Default to gpt-image-1 — available on all current OpenAI API tiers;
  // set IMAGE_MODEL=dall-e-3 explicitly if your API key has legacy DALL-E access.
  const model = process.env.IMAGE_MODEL ?? "gpt-image-1";
  const size = resolveSize(aspectRatio, model);
  const resolvedQuality = resolveQuality(quality, model);
  const { width, height } = sizeToPixels(size);

  const client = getClient();

  logger.info(
    { model, size, quality: resolvedQuality, promptLen: prompt.length },
    "image-provider: generating image",
  );

  // Build base params — omit response_format (rejected by gpt-image-* endpoints).
  // dall-e-3 defaults to "url"; gpt-image-1 returns b64_json; both handled below.
  const baseParams = {
    model,
    prompt,
    n: 1 as const,
    size,
    quality: resolvedQuality,
  };

  let response: Awaited<ReturnType<typeof client.images.generate>>;
  try {
    // Attempt with style first; gpt-image-* will reject it → caught & retried below.
    response = await client.images.generate({
      ...baseParams,
      style: style === "natural" ? "natural" : "vivid",
    });
  } catch (err) {
    // gpt-image-1 and proxies that remap dall-e-3 calls do not support 'style'.
    // Retry without it rather than hard-failing.
    const e = err as { code?: string; param?: string };
    if (e.code === "unknown_parameter" && e.param === "style") {
      logger.warn(
        { model },
        "image-provider: 'style' not supported by this endpoint — retrying without it",
      );
      response = await client.images.generate(baseParams);
    } else {
      throw err;
    }
  }

  const item = response.data?.[0];
  if (!item) {
    throw new Error("Image generation returned no data");
  }

  // Prefer a URL (dall-e-3); fall back to base64 data URI (gpt-image-1).
  let imageSource: string;
  if (item.url) {
    imageSource = item.url;
  } else if (item.b64_json) {
    imageSource = `data:image/png;base64,${item.b64_json}`;
  } else {
    throw new Error("Image generation returned neither a URL nor base64 data");
  }

  logger.info({ model, size }, "image-provider: generation complete");

  return {
    openaiUrl: imageSource,
    revisedPrompt: item.revised_prompt ?? null,
    width,
    height,
    mimeType: "image/png",
  };
}

export function isImageProviderConfigured(): boolean {
  return Boolean(
    process.env.OPENAI_IMAGE_API_KEY ?? process.env.IMAGE_API_KEY ?? process.env.OPENAI_API_KEY,
  );
}
