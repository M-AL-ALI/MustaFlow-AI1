import type { ImageAspectRatio, ImageQuality, ImageStyle } from "../image-provider";
import {
  normalizeOraPlanTier,
  oraImageQualityForPlan,
  type OraImageTask,
  type OraPlanTier,
} from "./model-router";

export type OraImagePromptKind =
  | "logo"
  | "icon"
  | "banner"
  | "poster"
  | "portrait"
  | "product"
  | "mockup"
  | "illustration"
  | "general";

export interface OraImageGenerationProfile {
  planTier: OraPlanTier;
  kind: OraImagePromptKind;
  originalPrompt: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  style: ImageStyle;
  quality: ImageQuality;
}

export interface OraImageEditProfile {
  planTier: OraPlanTier;
  originalInstruction: string;
  instruction: string;
  quality: ImageQuality;
}

const MAX_PROMPT_CHARS = 1_800;

function cleanUserText(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_PROMPT_CHARS
    ? `${cleaned.slice(0, MAX_PROMPT_CHARS).trim()}...`
    : cleaned;
}

export function inferOraImagePromptKind(prompt: string): OraImagePromptKind {
  const text = prompt.toLowerCase();
  if (/\b(logos?|brand\s+marks?|wordmarks?|emblems?)\b/.test(text)) return "logo";
  if (/\b(icons?|app\s+icons?|favicons?|badges?)\b/.test(text)) return "icon";
  if (/\b(banners?|headers?|hero\s+images?|covers?|thumbnails?|wallpapers?)\b/.test(text)) {
    return "banner";
  }
  if (/\b(posters?|flyers?|one[-\s]?sheets?|ads?|advertisements?)\b/.test(text)) return "poster";
  if (/\b(portraits?|avatars?|headshots?|profile\s+photos?)\b/.test(text)) return "portrait";
  if (/\b(product\s+(?:shot|photo|image|render)|packaging|bottle|sneaker|device)\b/.test(text)) {
    return "product";
  }
  if (/\b(mockups?|screenshot\s+mockups?|ui\s+mockups?|website\s+mockups?)\b/.test(text)) {
    return "mockup";
  }
  if (/\b(illustrations?|artworks?|drawings?|paintings?|sketches?|comic|anime)\b/.test(text)) {
    return "illustration";
  }
  return "general";
}

function resolveOraImageAspectRatio(prompt: string, kind: OraImagePromptKind): ImageAspectRatio {
  const text = prompt.toLowerCase();
  if (/\b(16:9|landscape|wide|banner|header|hero|cover|youtube\s+thumbnail)\b/.test(text)) {
    return "16:9";
  }
  if (
    /\b(9:16|vertical|portrait\s+layout|story|reel|tiktok|phone\s+wallpaper|mobile)\b/.test(text)
  ) {
    return "9:16";
  }
  if (kind === "banner") return "16:9";
  if (kind === "poster") return "9:16";
  return "1:1";
}

function resolveOraImageStyle(prompt: string, kind: OraImagePromptKind): ImageStyle {
  const text = prompt.toLowerCase();
  if (/\b(photo|photoreal|photorealistic|realistic|cinematic|studio\s+shot)\b/.test(text)) {
    return "natural";
  }
  if (kind === "logo" || kind === "icon" || kind === "product" || kind === "mockup") {
    return "natural";
  }
  return "vivid";
}

function planGuidance(planTier: OraPlanTier, task: OraImageTask): string {
  const taskNoun = task === "edit" ? "edit" : "image";
  switch (planTier) {
    case "wave":
      return `Make the ${taskNoun} production-ready: refined art direction, strong composition, crisp detail, coherent lighting, and no accidental artifacts.`;
    case "core":
      return `Make the ${taskNoun} polished and professional: clear subject, balanced composition, clean details, and practical visual quality.`;
    case "free":
    case "anonymous":
      return `Make the ${taskNoun} clean, useful, and easy to understand with one clear subject and minimal visual clutter.`;
  }
}

function kindGuidance(kind: OraImagePromptKind): string {
  switch (kind) {
    case "logo":
      return "Use a simple brandable mark with clean geometry, strong silhouette, and no random text or watermark.";
    case "icon":
      return "Use a centered symbol that stays readable at small sizes, with crisp edges and minimal background clutter.";
    case "banner":
      return "Use a wide composition with a strong focal point and enough negative space for optional overlay text.";
    case "poster":
      return "Use a vertical composition with clear hierarchy, strong focal point, and space for readable copy if requested.";
    case "portrait":
      return "Prioritize natural proportions, tasteful lighting, expressive but believable detail, and a clean background.";
    case "product":
      return "Use accurate perspective, clean studio lighting, realistic materials, and a commercial product-photo finish.";
    case "mockup":
      return "Use a realistic presentation context with clean alignment, readable surfaces, and no distorted interface details.";
    case "illustration":
      return "Use a cohesive illustration style, intentional color palette, and clear subject separation.";
    case "general":
      return "Keep the subject, setting, and style faithful to the user's request.";
  }
}

export function buildOraImageGenerationProfile(input: {
  prompt: string;
  subscriptionTier?: string | null;
  requestedQuality?: ImageQuality;
}): OraImageGenerationProfile {
  const originalPrompt = cleanUserText(input.prompt);
  const planTier = normalizeOraPlanTier(input.subscriptionTier);
  const kind = inferOraImagePromptKind(originalPrompt);
  const quality = oraImageQualityForPlan(planTier, "generation", input.requestedQuality);
  const aspectRatio = resolveOraImageAspectRatio(originalPrompt, kind);
  const style = resolveOraImageStyle(originalPrompt, kind);

  const prompt = [
    `User request: ${originalPrompt}`,
    planGuidance(planTier, "generation"),
    kindGuidance(kind),
    "Preserve the user's requested subject, mood, colors, brands, and constraints.",
    "If text is requested, keep it minimal and legible; otherwise do not add random text, captions, signatures, UI labels, or watermarks.",
  ].join(" ");

  return { planTier, kind, originalPrompt, prompt, aspectRatio, style, quality };
}

export function buildOraImageEditProfile(input: {
  instruction: string;
  subscriptionTier?: string | null;
  requestedQuality?: ImageQuality;
}): OraImageEditProfile {
  const originalInstruction = cleanUserText(input.instruction);
  const planTier = normalizeOraPlanTier(input.subscriptionTier);
  const quality = oraImageQualityForPlan(planTier, "edit", input.requestedQuality);
  const instruction = [
    `Edit instruction: ${originalInstruction}`,
    planGuidance(planTier, "edit"),
    "Preserve the original image identity, composition, people, product details, and important context unless the instruction explicitly changes them.",
    "Blend all changes naturally with matching lighting, perspective, texture, and edges.",
    "Do not add unrelated objects, random text, signatures, UI labels, or watermarks.",
  ].join(" ");

  return { planTier, originalInstruction, instruction, quality };
}
