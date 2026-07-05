import { describe, expect, it } from "vitest";
import { buildOraRoutingDiagnostic } from "../routing-diagnostics";

const premiumClassifier = {
  intent: "premium",
  confidence: "high",
  topic: "general",
} as const;

const technicalClassifier = {
  intent: "premium",
  confidence: "high",
  topic: "technical",
} as const;

const simpleFaqClassifier = {
  intent: "simple_faq",
  confidence: "high",
  topic: "product-features",
} as const;

describe("Ora routing diagnostics", () => {
  it("diagnoses conversational plan tiers, access, quota, and provider chains", async () => {
    const freeFaq = await buildOraRoutingDiagnostic({
      message: "what can Ora do?",
      subscriptionTier: "free",
      classifier: simpleFaqClassifier,
    });

    expect(freeFaq.tool).toBe("answer");
    expect(freeFaq.access?.allowed).toBe(true);
    expect(freeFaq.quotaKind).toBe("message");
    expect(freeFaq.usesRollingQuota).toBe(true);
    expect(freeFaq.routeTier).toBe("fast");
    expect(freeFaq.providerOrder).toEqual(["gemini", "deepseek", "anthropic", "openai"]);
    expect(freeFaq.terminalProvider).toBe("openai");

    const coreTechnical = await buildOraRoutingDiagnostic({
      message: "explain how to optimize a Postgres index strategy",
      subscriptionTier: "core",
      classifier: technicalClassifier,
    });

    expect(coreTechnical.tool).toBe("answer");
    expect(coreTechnical.routeTier).toBe("premium");
    expect(coreTechnical.providerOrder).toEqual(["anthropic", "deepseek", "gemini", "openai"]);

    const waveDeep = await buildOraRoutingDiagnostic({
      message: "analyze this launch strategy deeply",
      mode: "deep",
      subscriptionTier: "wave",
      classifier: premiumClassifier,
    });

    expect(waveDeep.tool).toBe("deep_thinking");
    expect(waveDeep.access?.allowed).toBe(true);
    expect(waveDeep.routeTier).toBe("deep");
    expect(waveDeep.providerOrder).toEqual(["anthropic", "gemini", "deepseek", "openai"]);

    const freeDeepDenied = await buildOraRoutingDiagnostic({
      message: "analyze this deeply",
      mode: "deep",
      subscriptionTier: "free",
      classifier: premiumClassifier,
    });

    expect(freeDeepDenied.tool).toBe("deep_thinking");
    expect(freeDeepDenied.access?.allowed).toBe(false);
    expect(freeDeepDenied.quotaKind).toBeNull();
    expect(freeDeepDenied.providerOrder).toEqual([]);
  });

  it("keeps search/media/image generation boundaries clear", async () => {
    const imageLookup = await buildOraRoutingDiagnostic({
      message: "find the official logo images for Perdue",
      subscriptionTier: "core",
    });

    expect(imageLookup.tool).toBe("search");
    expect(imageLookup.quotaKind).toBe("message");
    expect(imageLookup.searchProfile?.searchPlan.mediaIntent).toBe("image");
    expect(imageLookup.openaiModel).toBe("gpt-4o-mini");
    expect(imageLookup.providerOrder).toEqual([]);

    const videoSearch = await buildOraRoutingDiagnostic({
      message: "show me a video about composting",
      subscriptionTier: "wave",
    });

    expect(videoSearch.tool).toBe("search");
    expect(videoSearch.searchProfile?.searchPlan.mediaIntent).toBe("video");
    expect(videoSearch.searchProfile?.videoLimit).toBeGreaterThan(0);

    const imageGeneration = await buildOraRoutingDiagnostic({
      message: "generate an image of a sunset over the ocean",
      subscriptionTier: "wave",
    });

    expect(imageGeneration.tool).toBe("image_generation");
    expect(imageGeneration.quotaKind).toBe("image");
    expect(imageGeneration.image).toMatchObject({
      task: "generation",
      quality: "high",
      kind: "general",
    });
  });

  it("diagnoses file, dataset, vision, and memory specialist chains", async () => {
    const xlsxGeneration = await buildOraRoutingDiagnostic({
      surface: "file_generation",
      message: "create an xlsx budget tracker",
      fileFormat: "xlsx",
      subscriptionTier: "core",
    });

    expect(xlsxGeneration.tool).toBe("file_generation");
    expect(xlsxGeneration.quotaKind).toBe("message");
    expect(xlsxGeneration.providerOrder).toEqual(["anthropic", "deepseek", "gemini", "openai"]);

    const fileAnalysis = await buildOraRoutingDiagnostic({
      surface: "file_analysis",
      message: "summarize this uploaded document",
      subscriptionTier: "core",
    });

    expect(fileAnalysis.tool).toBe("file_analysis");
    expect(fileAnalysis.providerOrder).toEqual(["gemini", "anthropic", "deepseek", "openai"]);

    const datasetAnalysis = await buildOraRoutingDiagnostic({
      surface: "dataset_analysis",
      message: "analyze this CSV",
      subscriptionTier: "free",
    });

    expect(datasetAnalysis.tool).toBe("dataset_analysis");
    expect(datasetAnalysis.providerOrder).toEqual(["gemini", "anthropic", "deepseek", "openai"]);

    const vision = await buildOraRoutingDiagnostic({
      surface: "vision_analysis",
      message: "what is in this image?",
      subscriptionTier: "wave",
    });

    expect(vision.tool).toBe("image_analysis");
    expect(vision.providerOrder).toEqual(["gemini", "anthropic", "openai"]);
    expect(vision.providerOrder).not.toContain("deepseek");

    const memoryExtract = await buildOraRoutingDiagnostic({
      surface: "memory_extract",
      message: "remember that I prefer concise answers",
      subscriptionTier: "core",
    });

    expect(memoryExtract.quotaKind).toBeNull();
    expect(memoryExtract.providerOrder).toEqual(["anthropic", "gemini", "deepseek", "openai"]);

    const documentMemory = await buildOraRoutingDiagnostic({
      surface: "document_memory",
      message: "summarize this uploaded contract for future recall",
      subscriptionTier: "wave",
    });

    expect(documentMemory.providerOrder).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });

  it("wins image generation over file generation and continuations on ambiguous visual requests", async () => {
    // Visual request with a bare "word" token must generate an image, not a file.
    const logoWithText = await buildOraRoutingDiagnostic({
      message: "create a logo with the word bakery",
      subscriptionTier: "core",
    });
    expect(logoWithText.tool).toBe("image_generation");
    expect(logoWithText.quotaKind).toBe("image");

    // Explicit downloadable format still routes to a file even with a visual noun.
    const posterPdf = await buildOraRoutingDiagnostic({
      surface: "file_generation",
      message: "make a poster PDF",
      fileFormat: "pdf",
      subscriptionTier: "core",
    });
    expect(posterPdf.tool).toBe("file_generation");

    // A "go ahead" reply after a hallucinated image delivery generates the image.
    const continuation = await buildOraRoutingDiagnostic({
      message: "go ahead and generate it",
      subscriptionTier: "core",
      recentMessages: [
        { role: "user", content: "I asked for an image of the 2026 world cup" },
        {
          role: "assistant",
          content:
            "Here is a vivid, detailed image of the 2026 FIFA World Cup — featuring the golden trophy and a packed stadium.",
        },
      ],
    });
    expect(continuation.tool).toBe("image_generation");
    expect(continuation.quotaKind).toBe("image");

    // A definitional question about the feature stays conversational.
    const definitional = await buildOraRoutingDiagnostic({
      message: "what is image generation?",
      subscriptionTier: "core",
      classifier: premiumClassifier,
    });
    expect(definitional.tool).toBe("answer");
  });

  it("routes past-tense 'asked for/requested … image' complaint framing to image generation", async () => {
    // The reported failure phrasing: the user re-states an unfulfilled image
    // request as a fresh turn (no prior assistant offer). It must generate an
    // image rather than fall through to conversational chat.
    const askedFor = await buildOraRoutingDiagnostic({
      message: "I asked for image for world cup of 2026",
      subscriptionTier: "core",
      classifier: premiumClassifier,
    });
    expect(askedFor.tool).toBe("image_generation");
    expect(askedFor.quotaKind).toBe("image");

    const requested = await buildOraRoutingDiagnostic({
      message: "I requested an image for the world cup",
      subscriptionTier: "core",
      classifier: premiumClassifier,
    });
    expect(requested.tool).toBe("image_generation");

    // Guard: "asked for/requested" WITHOUT a visual noun must stay conversational.
    const askedForHelp = await buildOraRoutingDiagnostic({
      message: "I asked for help understanding my invoice",
      subscriptionTier: "core",
      classifier: premiumClassifier,
    });
    expect(askedForHelp.tool).toBe("answer");

    const requestedRefund = await buildOraRoutingDiagnostic({
      message: "I requested a refund yesterday",
      subscriptionTier: "core",
      classifier: premiumClassifier,
    });
    expect(requestedRefund.tool).toBe("answer");
  });

  it("diagnoses image edit as live, image-metered, and OpenAI image-model backed", async () => {
    const imageEdit = await buildOraRoutingDiagnostic({
      surface: "image_edit",
      message: "make the sky sunset orange",
      subscriptionTier: "core",
    });

    expect(imageEdit.tool).toBe("image_editing");
    expect(imageEdit.access?.allowed).toBe(true);
    expect(imageEdit.quotaKind).toBe("image");
    expect(imageEdit.usesRollingQuota).toBe(true);
    expect(imageEdit.openaiModel).toBe("gpt-image-1");
    expect(imageEdit.providerOrder).toEqual([]);
    expect(imageEdit.image).toMatchObject({ task: "edit", quality: "high" });
  });
});
