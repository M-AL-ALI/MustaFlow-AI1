/**
 * Image generation provider abstraction — Phase 9A-1.
 *
 * ISOLATION: this file MUST NOT import from builder.ts, ai.ts, or any
 * builder pipeline module. It is the sole entry point for image generation.
 *
 * Required env:
 *   OPENAI_IMAGE_API_KEY — direct OpenAI API key for image models (preferred)
 *   IMAGE_API_KEY        — legacy alias (still accepted)
 *   OPENAI_API_KEY       — fallback if neither image-specific key is set
 *   IMAGE_MODEL          — legacy model override (default: gpt-image-1)
 *   ORA_*_IMAGE_MODEL    — plan-aware model overrides (free/core/wave)
 *   ORA_*_IMAGE_QUALITY  — plan-aware default quality overrides
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
import OpenAI, { toFile } from "openai";
import { logger } from "./logger";
import {
  normalizeOraPlanTier,
  openAiModelForOraImage,
  oraImageQualityForPlan,
  type OraImageQuality,
} from "./public-ai/model-router";

export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageQuality = OraImageQuality;
export type ImageStyle = "vivid" | "natural";

export interface ImageGenerateOptions {
  prompt: string;
  quality?: ImageQuality;
  aspectRatio?: ImageAspectRatio;
  style?: ImageStyle;
  transparentBackground?: boolean;
  subscriptionTier?: string | null;
}

export interface ImageGenerateResult {
  /**
   * Either a temporary OpenAI CDN URL (dall-e-3 default) or a data URI
   * (`data:image/png;base64,...`) when gpt-image-1 returns b64_json.
   * image-storage.ts handles both transparently.
   */
  openaiUrl: string;
  revisedPrompt: string | null;
  width: number;
  height: number;
  mimeType: string;
  providerName: "openai";
  modelName: string;
  quality: ImageQuality;
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

// ── Key helpers (used by isImageProviderConfigured + auditImageProviderConfig) ─

function isProxyConfigured(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  );
}

function getDirectKey(): string {
  return (
    process.env.OPENAI_IMAGE_API_KEY ??
    process.env.IMAGE_API_KEY ??
    process.env.OPENAI_API_KEY ??
    ""
  );
}

// ── API client ────────────────────────────────────────────────────────────────

function getClient(): OpenAI {
  const apiKey = getDirectKey();
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

  const { prompt, aspectRatio = "1:1", style = "vivid" } = opts;
  const planTier = normalizeOraPlanTier(opts.subscriptionTier);

  // Default to gpt-image-1 — available on all current OpenAI API tiers;
  // set IMAGE_MODEL=dall-e-3 explicitly if your API key has legacy DALL-E access.
  const model = openAiModelForOraImage("generation", planTier);
  const quality = oraImageQualityForPlan(planTier, "generation", opts.quality);
  const size = resolveSize(aspectRatio, model);
  const resolvedQuality = resolveQuality(quality, model);
  const { width, height } = sizeToPixels(size);

  const client = getClient();

  logger.info(
    { model, planTier, size, quality, providerQuality: resolvedQuality, promptLen: prompt.length },
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

  logger.info({ model, planTier, size, quality }, "image-provider: generation complete");

  return {
    openaiUrl: imageSource,
    revisedPrompt: item.revised_prompt ?? null,
    width,
    height,
    mimeType: "image/png",
    providerName: "openai",
    modelName: model,
    quality,
  };
}

// ── Edit function ─────────────────────────────────────────────────────────────

export interface ImageEditOptions {
  imageBuffer: Buffer;
  instruction: string;
  quality?: ImageQuality;
  aspectRatio?: ImageAspectRatio;
  subscriptionTier?: string | null;
}

/**
 * Edit an existing image using the provider's edit/inpainting API.
 * Converts the source buffer to a File object and calls client.images.edit().
 */
export async function editImage(opts: ImageEditOptions): Promise<ImageGenerateResult> {
  const { imageBuffer, instruction, aspectRatio = "1:1" } = opts;
  const planTier = normalizeOraPlanTier(opts.subscriptionTier);

  const model = openAiModelForOraImage("edit", planTier);
  const quality = oraImageQualityForPlan(planTier, "edit", opts.quality);
  const size = resolveSize(aspectRatio, model);
  const resolvedQuality = resolveQuality(quality, model);
  const { width, height } = sizeToPixels(size);

  const client = getClient();

  logger.info(
    {
      model,
      planTier,
      size,
      quality,
      providerQuality: resolvedQuality,
      instructionLen: instruction.length,
    },
    "image-provider: editing image",
  );

  const imageFile = await toFile(imageBuffer, "image.webp", { type: "image/webp" });

  // The edit endpoint only supports gpt-image quality values (low/medium/high/standard/auto).
  // Map "hd" (dall-e-3 legacy) → "high" so the call is always valid.
  const editQuality = (resolvedQuality === "hd" ? "high" : resolvedQuality) as
    | "low"
    | "medium"
    | "high"
    | "standard";

  const baseParams = {
    image: imageFile,
    prompt: instruction,
    model,
    n: 1 as const,
    size,
    quality: editQuality,
  };

  let response: OpenAI.ImagesResponse;
  try {
    response = (await client.images.edit(baseParams)) as OpenAI.ImagesResponse;
  } catch (err) {
    const e = err as { code?: string; param?: string };
    if (e.code === "unknown_parameter" && e.param === "quality") {
      logger.warn(
        { model },
        "image-provider: 'quality' not supported by edit endpoint — retrying without it",
      );
      const { quality: _q, ...paramsWithoutQuality } = baseParams;
      void _q;
      response = (await client.images.edit(
        paramsWithoutQuality as Parameters<typeof client.images.edit>[0],
      )) as OpenAI.ImagesResponse;
    } else {
      throw err;
    }
  }

  const item = response.data?.[0];
  if (!item) throw new Error("Image edit returned no data");

  let imageSource: string;
  if (item.url) {
    imageSource = item.url;
  } else if (item.b64_json) {
    imageSource = `data:image/png;base64,${item.b64_json}`;
  } else {
    throw new Error("Image edit returned neither a URL nor base64 data");
  }

  logger.info({ model, planTier, size, quality }, "image-provider: edit complete");

  return {
    openaiUrl: imageSource,
    revisedPrompt: item.revised_prompt ?? null,
    width,
    height,
    mimeType: "image/png",
    providerName: "openai",
    modelName: model,
    quality,
  };
}

export function isImageProviderConfigured(): boolean {
  return isProxyConfigured() || Boolean(getDirectKey());
}

/**
 * Returns a structured audit of which image provider keys are present.
 * Values are NEVER included — only boolean presence flags.
 * Safe to log at server startup.
 */
export function auditImageProviderConfig(): {
  hasOpenAIImageKey: boolean;
  hasImageApiKey: boolean;
  hasOpenAIKey: boolean;
  hasProxyBaseUrl: boolean;
  hasProxyKey: boolean;
  activeProviderPath: "proxy" | "direct" | "none";
} {
  const hasOpenAIImageKey = Boolean(process.env.OPENAI_IMAGE_API_KEY);
  const hasImageApiKey = Boolean(process.env.IMAGE_API_KEY);
  const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
  const hasProxyBaseUrl = Boolean(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL);
  const hasProxyKey = Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY);

  // getClient() resolves the key via getDirectKey() and passes no baseURL —
  // it always calls api.openai.com directly. The Replit proxy env vars
  // (AI_INTEGRATIONS_OPENAI_*) are present for text-model calls but are
  // NOT used by generateImage(). Report "direct" when a direct key is set.
  const activeProviderPath =
    hasOpenAIImageKey || hasImageApiKey || hasOpenAIKey
      ? "direct"
      : isProxyConfigured()
        ? "proxy"
        : "none";

  return {
    hasOpenAIImageKey,
    hasImageApiKey,
    hasOpenAIKey,
    hasProxyBaseUrl,
    hasProxyKey,
    activeProviderPath,
  };
}
