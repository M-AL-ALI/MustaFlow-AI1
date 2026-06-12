import type { Provider } from "../ai-providers";
import type { FileFormat } from "./prompt";
import type { OraConfidence, OraIntent, OraTopic } from "./classifier";
import {
  checkToolAccess,
  routeOraMessage,
  type OraAccessResult,
  type OraRouteDecision,
  type OraTool,
} from "./orchestrator";
import {
  normalizeOraPlanTier,
  openAiModelForOraFile,
  openAiModelForOraImage,
  openAiModelForOraMemory,
  openAiModelForOraRoute,
  openAiModelForOraSearch,
  openAiModelForOraVision,
  selectOraFileModelRoute,
  selectOraMemoryModelRoute,
  selectOraModelRoute,
  selectOraVisionModelRoute,
  type ModelCandidate,
  type OraFileTask,
  type OraImageTask,
  type OraMemoryTask,
  type OraPlanTier,
  type OraRouteTier,
} from "./model-router";
import { buildOraImageEditProfile, buildOraImageGenerationProfile } from "./image-quality";
import { resolveOraSearchProfile, type OraSearchProfile } from "./web-search";

export type OraDiagnosticSurface =
  | "auto"
  | "answer"
  | "deep_thinking"
  | "search"
  | "file_generation"
  | "file_analysis"
  | "dataset_analysis"
  | "vision_analysis"
  | "memory_extract"
  | "conversation_summary"
  | "document_memory"
  | "image_generation"
  | "image_edit";

export type OraDiagnosticQuotaKind = "message" | "image" | null;

export interface OraRoutingDiagnosticInput {
  surface?: OraDiagnosticSurface;
  message: string;
  mode?: "instant" | "deep";
  subscriptionTier?: string | null;
  classifier?: { intent: OraIntent; confidence: OraConfidence; topic: OraTopic };
  language?: string;
  languageHint?: string;
  hasDocumentContext?: boolean;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  fileFormat?: FileFormat;
  fileTask?: OraFileTask;
  memoryTask?: OraMemoryTask;
  imageTask?: OraImageTask;
  available?: Partial<Record<Provider, boolean>>;
  openCircuits?: ReadonlySet<Provider>;
}

export interface OraRoutingDiagnostic {
  surface: OraDiagnosticSurface;
  planTier: OraPlanTier;
  tool: OraTool | null;
  access: OraAccessResult | null;
  quotaKind: OraDiagnosticQuotaKind;
  usesRollingQuota: boolean;
  routeTier: OraRouteTier | null;
  openaiModel: string | null;
  candidates: ModelCandidate[];
  providerOrder: Provider[];
  terminalProvider: Provider | null;
  searchProfile?: Pick<
    OraSearchProfile,
    "depth" | "sourceLimit" | "imageLimit" | "videoLimit" | "searchPlan"
  >;
  image?: {
    task: OraImageTask;
    quality: string;
    aspectRatio?: string;
    style?: string;
    kind?: string;
  };
  decision?: OraRouteDecision;
}

const DEFAULT_AVAILABLE: Record<Provider, boolean> = {
  openai: true,
  anthropic: true,
  gemini: true,
  deepseek: true,
};

function completeAvailability(
  available: Partial<Record<Provider, boolean>> | undefined,
): Record<Provider, boolean> {
  return { ...DEFAULT_AVAILABLE, ...(available ?? {}) };
}

function isPaidPlan(planTier: OraPlanTier): boolean {
  return planTier === "core" || planTier === "wave";
}

function isNonEnglishLanguage(value: string | undefined): boolean {
  if (!value || value === "auto") return false;
  const primary = value.split(",")[0].trim().split("-")[0].toLowerCase();
  return !!primary && primary !== "en";
}

function quotaKindForTool(tool: OraTool | null): OraDiagnosticQuotaKind {
  if (!tool) return null;
  return tool === "image_generation" || tool === "image_editing" ? "image" : "message";
}

function routeTierForDecision(decision: OraRouteDecision): OraRouteTier | null {
  if (decision.tool === "deep_thinking") return "deep";
  if (decision.tool !== "answer") return null;
  return decision.intent === "simple_faq" && decision.confidence === "high" ? "fast" : "premium";
}

function routeTierForSurface(surface: OraDiagnosticSurface): OraRouteTier | null {
  if (surface === "deep_thinking") return "deep";
  if (surface === "answer") return "premium";
  return null;
}

function diagnosticBase(input: OraRoutingDiagnosticInput): {
  planTier: OraPlanTier;
  available: Record<Provider, boolean>;
  openCircuits: ReadonlySet<Provider>;
} {
  return {
    planTier: normalizeOraPlanTier(input.subscriptionTier),
    available: completeAvailability(input.available),
    openCircuits: input.openCircuits ?? new Set<Provider>(),
  };
}

function fromCandidates(input: {
  surface: OraDiagnosticSurface;
  planTier: OraPlanTier;
  tool: OraTool | null;
  access: OraAccessResult | null;
  quotaKind: OraDiagnosticQuotaKind;
  routeTier: OraRouteTier | null;
  openaiModel: string | null;
  candidates?: ModelCandidate[];
  decision?: OraRouteDecision;
}): OraRoutingDiagnostic {
  const candidates = input.candidates ?? [];
  return {
    surface: input.surface,
    planTier: input.planTier,
    tool: input.tool,
    access: input.access,
    quotaKind: input.quotaKind,
    usesRollingQuota: input.planTier !== "anonymous" && input.quotaKind !== null,
    routeTier: input.routeTier,
    openaiModel: input.openaiModel,
    candidates,
    providerOrder: candidates.map((c) => c.provider),
    terminalProvider: candidates[candidates.length - 1]?.provider ?? null,
    ...(input.decision ? { decision: input.decision } : {}),
  };
}

export async function buildOraRoutingDiagnostic(
  input: OraRoutingDiagnosticInput,
): Promise<OraRoutingDiagnostic> {
  const surface = input.surface ?? "auto";
  const { planTier, available, openCircuits } = diagnosticBase(input);
  const authed = planTier !== "anonymous";
  const accessContext = { authed, isPaid: isPaidPlan(planTier) };

  if (surface === "auto") {
    const decision = await routeOraMessage({
      message: input.message,
      mode: input.mode ?? "instant",
      classifier: input.classifier,
      recentMessages: input.recentMessages,
    });
    const access = checkToolAccess(decision.tool, accessContext);
    const quotaKind = access.allowed ? quotaKindForTool(decision.tool) : null;
    const routeTier = access.allowed ? routeTierForDecision(decision) : null;

    if (decision.tool === "answer" || decision.tool === "deep_thinking") {
      let openaiModel: string | null = null;
      let candidates: ModelCandidate[] = [];
      if (routeTier !== null) {
        openaiModel = openAiModelForOraRoute(routeTier, planTier);
        candidates = selectOraModelRoute({
          tier: routeTier,
          subscriptionTier: planTier,
          topic: decision.topic,
          intent: decision.intent,
          confidence: decision.confidence,
          multilingual:
            isNonEnglishLanguage(input.language) || isNonEnglishLanguage(input.languageHint),
          hasDocumentContext: input.hasDocumentContext,
          available,
          openCircuits,
          openaiModel,
        });
      }
      return fromCandidates({
        surface,
        planTier,
        tool: decision.tool,
        access,
        quotaKind,
        routeTier,
        openaiModel,
        candidates,
        decision,
      });
    }

    if (decision.tool === "file_generation" && decision.fileFormat) {
      return buildOraRoutingDiagnostic({
        ...input,
        surface: "file_generation",
        fileFormat: decision.fileFormat,
      });
    }

    if (decision.tool === "search") {
      const openaiModel = openAiModelForOraSearch(planTier);
      const diagnostic = fromCandidates({
        surface,
        planTier,
        tool: "search",
        access,
        quotaKind,
        routeTier,
        openaiModel,
        decision,
      });
      diagnostic.searchProfile = resolveOraSearchProfile({
        query: input.message,
        planTier,
        wantsVideos: decision.wantsVideos,
      });
      return diagnostic;
    }

    if (decision.tool === "image_generation") {
      const imageProfile = buildOraImageGenerationProfile({
        prompt: decision.imagePrompt ?? input.message,
        subscriptionTier: planTier,
      });
      const diagnostic = fromCandidates({
        surface,
        planTier,
        tool: "image_generation",
        access,
        quotaKind,
        routeTier,
        openaiModel: openAiModelForOraImage("generation", planTier),
        decision,
      });
      diagnostic.image = {
        task: "generation",
        quality: imageProfile.quality,
        aspectRatio: imageProfile.aspectRatio,
        style: imageProfile.style,
        kind: imageProfile.kind,
      };
      return diagnostic;
    }

    return fromCandidates({
      surface,
      planTier,
      tool: decision.tool,
      access,
      quotaKind,
      routeTier,
      openaiModel: null,
      decision,
    });
  }

  if (surface === "answer" || surface === "deep_thinking") {
    const tool: OraTool = surface;
    const access = checkToolAccess(tool, accessContext);
    const routeTier = access.allowed ? routeTierForSurface(surface) : null;
    let openaiModel: string | null = null;
    let candidates: ModelCandidate[] = [];
    if (routeTier !== null) {
      openaiModel = openAiModelForOraRoute(routeTier, planTier);
      candidates = selectOraModelRoute({
        tier: routeTier,
        subscriptionTier: planTier,
        topic: input.classifier?.topic ?? "general",
        intent: input.classifier?.intent ?? "premium",
        confidence: input.classifier?.confidence ?? "high",
        multilingual:
          isNonEnglishLanguage(input.language) || isNonEnglishLanguage(input.languageHint),
        hasDocumentContext: input.hasDocumentContext,
        available,
        openCircuits,
        openaiModel,
      });
    }
    return fromCandidates({
      surface,
      planTier,
      tool,
      access,
      quotaKind: access.allowed ? quotaKindForTool(tool) : null,
      routeTier,
      openaiModel,
      candidates,
    });
  }

  if (
    surface === "file_generation" ||
    surface === "file_analysis" ||
    surface === "dataset_analysis"
  ) {
    const task: OraFileTask =
      input.fileTask ??
      (surface === "dataset_analysis"
        ? "dataset_analysis"
        : surface === "file_analysis"
          ? "analysis"
          : "generation");
    const tool: OraTool =
      surface === "dataset_analysis"
        ? "dataset_analysis"
        : surface === "file_analysis"
          ? "file_analysis"
          : "file_generation";
    const access = checkToolAccess(tool, accessContext);
    const openaiModel = openAiModelForOraFile(task, planTier);
    const candidates = selectOraFileModelRoute({
      task,
      subscriptionTier: planTier,
      topic:
        task === "dataset_analysis" || input.fileFormat === "csv" || input.fileFormat === "xlsx"
          ? "technical"
          : "general",
      multilingual: isNonEnglishLanguage(input.language),
      hasDocumentContext: input.hasDocumentContext,
      available,
      openCircuits,
      openaiModel,
    });
    return fromCandidates({
      surface,
      planTier,
      tool,
      access,
      quotaKind: access.allowed ? "message" : null,
      routeTier: "premium",
      openaiModel,
      candidates,
    });
  }

  if (surface === "vision_analysis") {
    const tool: OraTool = "image_analysis";
    const access = checkToolAccess(tool, accessContext);
    const openaiModel = openAiModelForOraVision(planTier);
    const candidates = selectOraVisionModelRoute({
      subscriptionTier: planTier,
      multilingual: isNonEnglishLanguage(input.language),
      available,
      openCircuits,
      openaiModel,
    });
    return fromCandidates({
      surface,
      planTier,
      tool,
      access,
      quotaKind: access.allowed ? "message" : null,
      routeTier: "premium",
      openaiModel,
      candidates,
    });
  }

  if (
    surface === "memory_extract" ||
    surface === "conversation_summary" ||
    surface === "document_memory"
  ) {
    const task: OraMemoryTask =
      input.memoryTask ??
      (surface === "conversation_summary"
        ? "conversation_summary"
        : surface === "document_memory"
          ? "document_summary"
          : "extract");
    const openaiModel = openAiModelForOraMemory(task, planTier);
    const candidates = selectOraMemoryModelRoute({
      task,
      subscriptionTier: planTier,
      multilingual: isNonEnglishLanguage(input.language),
      hasDocumentContext: surface === "document_memory" || input.hasDocumentContext,
      available,
      openCircuits,
      openaiModel,
    });
    return fromCandidates({
      surface,
      planTier,
      tool: "memory_save_candidate",
      access: null,
      quotaKind: null,
      routeTier: "premium",
      openaiModel,
      candidates,
    });
  }

  if (surface === "search") {
    const access = checkToolAccess("search", accessContext);
    const openaiModel = openAiModelForOraSearch(planTier);
    const diagnostic = fromCandidates({
      surface,
      planTier,
      tool: "search",
      access,
      quotaKind: access.allowed ? "message" : null,
      routeTier: null,
      openaiModel,
    });
    diagnostic.searchProfile = resolveOraSearchProfile({ query: input.message, planTier });
    return diagnostic;
  }

  const imageTask: OraImageTask =
    input.imageTask ?? (surface === "image_edit" ? "edit" : "generation");
  const tool: OraTool = imageTask === "edit" ? "image_editing" : "image_generation";
  const access = checkToolAccess(tool, accessContext);
  const diagnostic = fromCandidates({
    surface,
    planTier,
    tool,
    access,
    quotaKind: access.allowed ? "image" : null,
    routeTier: null,
    openaiModel: openAiModelForOraImage(imageTask, planTier),
  });
  if (imageTask === "edit") {
    const image = buildOraImageEditProfile({
      instruction: input.message,
      subscriptionTier: planTier,
    });
    diagnostic.image = {
      task: "edit",
      quality: image.quality,
    };
  } else {
    const image = buildOraImageGenerationProfile({
      prompt: input.message,
      subscriptionTier: planTier,
    });
    diagnostic.image = {
      task: "generation",
      quality: image.quality,
      aspectRatio: image.aspectRatio,
      style: image.style,
      kind: image.kind,
    };
  }
  return diagnostic;
}
