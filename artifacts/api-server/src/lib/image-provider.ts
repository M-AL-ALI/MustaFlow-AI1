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
 *   IMAGE_MODEL     — model override (default: dall-e-3)
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

function resolveSize(aspectRatio: ImageAspectRatio): "1024x1024" | "1792x1024" | "1024x1792" {
  switch (aspectRatio) {
    case "16:9":
      return "1792x1024";
    case "9:16":
      return "1024x1792";
    default:
      return "1024x1024";
  }
}

function resolveOpenAIQuality(quality: ImageQuality): "standard" | "hd" {
  return quality === "high" ? "hd" : "standard";
}

function sizeToPixels(size: "1024x1024" | "1792x1024" | "1024x1792"): {
  width: number;
  height: number;
} {
  const [w, h] = size.split("x").map(Number);
  return { width: w!, height: h! };
}

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

export async function generateImage(opts: ImageGenerateOptions): Promise<ImageGenerateResult> {
  const provider = getActiveProviderName();
  if (provider !== "openai") {
    logger.warn(
      { provider },
      "image-provider: IMAGE_PROVIDER value is not supported; only 'openai' is available — falling back to openai",
    );
  }

  const { prompt, quality = "standard", aspectRatio = "1:1", style = "vivid" } = opts;

  const model = process.env.IMAGE_MODEL ?? "dall-e-3";
  const size = resolveSize(aspectRatio);
  const openaiQuality = resolveOpenAIQuality(quality);
  const { width, height } = sizeToPixels(size);

  const client = getClient();

  logger.info(
    { model, size, quality: openaiQuality, promptLen: prompt.length },
    "image-provider: generating image",
  );

  const response = await client.images.generate({
    model,
    prompt,
    n: 1,
    size,
    quality: openaiQuality,
    style: style === "natural" ? "natural" : "vivid",
    response_format: "url",
  });

  const item = response.data?.[0];
  if (!item?.url) {
    throw new Error("Image generation returned no URL");
  }

  logger.info({ model, size }, "image-provider: generation complete");

  return {
    openaiUrl: item.url,
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
