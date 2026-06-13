import { describe, expect, it } from "vitest";
import { routeOraMessage } from "../orchestrator";
import { buildOraRoutingDiagnostic } from "../routing-diagnostics";
import {
  collectPastedReferenceSignals,
  detectFileRequest,
  isPastedReferenceAnalysisRequest,
  ORA_SYSTEM_PROMPT,
  summarizePastedReferenceSignals,
} from "../prompt";

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

const longReplitReport = `Pull already triggered automatically. Let me check what landed and start the test while quality-gate runs.
Wiring test 3/3 PASS. Let me read the pull result and check format/quality-gate/typecheck now.
Pull clean at 42e493f1, lint FINISHED (0 errors), wiring test 3/3 PASS.
expo-env.d.ts formatting issue is recurring on every pull -- fixing it now while typecheck finishes.
All workflows done. Let me read the final results from the new log files.
All checks confirmed clean. Let me write the commit message and wrap up.

All done. Here's the full summary for commit 42e493f1:

Pulled files
ora-routing-diagnostics-panel.tsx -- 678-line admin panel UI
ora-routing-diagnostics-panel.test.ts -- wiring tests
admin.tsx -- panel import wired in

Verification results -- all clean
vitest (mustaflow): 3/3 PASS
lint: 0 errors
codegen-drift: PASS
typecheck: PASS (all 6 packages, 16.1s)
quality-gate: PASS
format: PASS

What should I tell Replit?`;

const copiedMultiSectionReport = `Codex says:

1. The route now sees copied Replit reports as analysis material.
2. The file generator should not run just because the pasted log mentions files.
3. Long copied text must be read as one reference block.

Replit says:

- model-router.test.ts: PASS
- phase1.test.ts: PASS
- quality-gate: PASS
- typecheck: PASS
- file-builder.ts was not changed
- no migration needed

My question: is there anything wrong here, and what should I reply?`;

describe("Ora real-user behavior QA", () => {
  it("keeps pasted Replit/Codex verification reports conversational, technical, and non-file-generating", async () => {
    expect(isPastedReferenceAnalysisRequest(longReplitReport)).toBe(true);
    expect(detectFileRequest(longReplitReport)).toBeNull();

    const decision = await routeOraMessage({ message: longReplitReport, mode: "instant" });

    expect(decision.tool).toBe("answer");
    expect(decision.intent).toBe("premium");
    expect(decision.confidence).toBe("high");
    expect(decision.topic).toBe("technical");
    expect(decision.reason).toContain("pasted tool/workflow output");

    const diagnostic = await buildOraRoutingDiagnostic({
      message: longReplitReport,
      subscriptionTier: "core",
    });

    expect(diagnostic.tool).toBe("answer");
    expect(diagnostic.routeTier).toBe("premium");
    expect(diagnostic.providerOrder).toEqual(["anthropic", "deepseek", "gemini", "openai"]);
    expect(diagnostic.terminalProvider).toBe("openai");
  });

  it("answers direct Replit/Codex reply questions as technical analysis instead of generic chat", async () => {
    const prompts = [
      "What should I tell Replit?",
      "What should I tell Codex about this?",
      "What do I reply to ChatGPT after this code review?",
    ];

    for (const message of prompts) {
      const decision = await routeOraMessage({ message, mode: "instant" });
      expect(decision.tool, message).toBe("answer");
      expect(decision.topic, message).toBe("technical");
      expect(decision.reason, message).toContain("pasted tool/workflow output");
    }
  });

  it("treats long copied status text as reference evidence and reads it before routing", async () => {
    expect(isPastedReferenceAnalysisRequest(copiedMultiSectionReport)).toBe(true);
    expect(detectFileRequest(copiedMultiSectionReport)).toBeNull();

    const diagnostic = await buildOraRoutingDiagnostic({
      message: copiedMultiSectionReport,
      subscriptionTier: "free",
    });

    expect(diagnostic.tool).toBe("answer");
    expect(diagnostic.routeTier).toBe("premium");
    expect(diagnostic.quotaKind).toBe("message");
    expect(diagnostic.providerOrder).toEqual(["deepseek", "gemini", "anthropic", "openai"]);
  });

  it("extracts visible pasted-report signals so long logs are not skimmed", () => {
    const signals = collectPastedReferenceSignals(longReplitReport);

    expect(signals.actors).toContain("Replit");
    expect(signals.commits).toContain("42e493f1");
    expect(signals.files).toEqual(
      expect.arrayContaining(["ora-routing-diagnostics-panel.tsx", "admin.tsx"]),
    );
    expect(signals.replyTargets).toEqual(["Replit"]);
    expect(signals.statusLines.join("\n")).toContain("quality-gate: PASS");

    const promptSummary = summarizePastedReferenceSignals(longReplitReport);
    expect(promptSummary).toContain("Pasted reference signals");
    expect(promptSummary).toContain("42e493f1");
    expect(promptSummary).toContain("admin.tsx");
    expect(promptSummary).toContain("User is asking what to tell: Replit");
  });

  it("keeps memory recall conversational while routing memory extraction and document memory through specialist chains", async () => {
    const recallDecision = await routeOraMessage({
      message: "What did I tell you my preferred answer style is?",
      mode: "instant",
      classifier: premiumClassifier,
    });

    expect(recallDecision.tool).toBe("answer");

    const memoryExtract = await buildOraRoutingDiagnostic({
      surface: "memory_extract",
      message: "Remember that I prefer direct answers with minimal steps.",
      subscriptionTier: "core",
    });

    expect(memoryExtract.tool).toBe("memory_save_candidate");
    expect(memoryExtract.quotaKind).toBeNull();
    expect(memoryExtract.providerOrder).toEqual(["anthropic", "gemini", "deepseek", "openai"]);

    const documentMemory = await buildOraRoutingDiagnostic({
      surface: "document_memory",
      message: "Remember the important details from this uploaded contract.",
      subscriptionTier: "wave",
    });

    expect(documentMemory.providerOrder).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });

  it("routes file creation, file analysis, and dataset analysis to plan-aware file specialists", async () => {
    const createXlsx = await routeOraMessage({
      message: "Create an XLSX budget tracker for my shop expenses.",
      mode: "instant",
    });

    expect(createXlsx.tool).toBe("file_generation");
    expect(createXlsx.fileFormat).toBe("xlsx");

    const generationDiagnostic = await buildOraRoutingDiagnostic({
      surface: "file_generation",
      message: "Create an XLSX budget tracker for my shop expenses.",
      fileFormat: "xlsx",
      subscriptionTier: "core",
    });

    expect(generationDiagnostic.tool).toBe("file_generation");
    expect(generationDiagnostic.providerOrder).toEqual([
      "anthropic",
      "deepseek",
      "gemini",
      "openai",
    ]);

    const fileAnalysis = await buildOraRoutingDiagnostic({
      surface: "file_analysis",
      message: "Analyze this uploaded PDF and summarize the risks.",
      subscriptionTier: "core",
    });

    expect(fileAnalysis.tool).toBe("file_analysis");
    expect(fileAnalysis.providerOrder).toEqual(["gemini", "anthropic", "deepseek", "openai"]);

    const datasetAnalysis = await buildOraRoutingDiagnostic({
      surface: "dataset_analysis",
      message: "Analyze this CSV and identify sales trends.",
      subscriptionTier: "wave",
    });

    expect(datasetAnalysis.tool).toBe("dataset_analysis");
    expect(datasetAnalysis.providerOrder).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });

  it("keeps image generation, image lookup, and video search on distinct paths", async () => {
    const imageGeneration = await buildOraRoutingDiagnostic({
      message: "Create a clean logo for my mobile mechanic app.",
      subscriptionTier: "core",
    });

    expect(imageGeneration.tool).toBe("image_generation");
    expect(imageGeneration.quotaKind).toBe("image");
    expect(imageGeneration.image).toMatchObject({
      kind: "logo",
      aspectRatio: "1:1",
      quality: "high",
    });

    const imageLookup = await buildOraRoutingDiagnostic({
      message: "Find the official logo images for Perdue.",
      subscriptionTier: "core",
    });

    expect(imageLookup.tool).toBe("search");
    expect(imageLookup.searchProfile?.searchPlan.mediaIntent).toBe("image");

    const videoSearch = await buildOraRoutingDiagnostic({
      message: "Show me a video about replacing brake pads.",
      subscriptionTier: "wave",
    });

    expect(videoSearch.tool).toBe("search");
    expect(videoSearch.decision?.wantsVideos).toBe(true);
    expect(videoSearch.searchProfile?.searchPlan.mediaIntent).toBe("video");
    expect(videoSearch.searchProfile?.videoLimit).toBeGreaterThan(0);
  });

  it("keeps response-style instructions aligned with the usability fixes", () => {
    expect(ORA_SYSTEM_PROMPT).toContain("Replit is the hosted development/runtime workspace");
    expect(ORA_SYSTEM_PROMPT).toContain("Codex is OpenAI's coding agent");
    expect(ORA_SYSTEM_PROMPT).toContain("answer with the exact short message first");
    expect(ORA_SYSTEM_PROMPT).toContain("read and reason over the full pasted content");
    expect(ORA_SYSTEM_PROMPT).toContain("Start pasted-report answers with the direct diagnosis");
    expect(ORA_SYSTEM_PROMPT).toContain("Use only the minimum useful steps");
  });

  it("routes plan-aware technical answers through stronger specialists and terminal OpenAI fallback", async () => {
    const diagnostic = await buildOraRoutingDiagnostic({
      message: "Review this API concurrency bug and tell me the likely root cause.",
      subscriptionTier: "wave",
      classifier: technicalClassifier,
      available: { deepseek: false },
      openCircuits: new Set(["anthropic" as const]),
    });

    expect(diagnostic.tool).toBe("answer");
    expect(diagnostic.routeTier).toBe("premium");
    expect(diagnostic.providerOrder).toEqual(["gemini", "anthropic", "openai"]);
    expect(diagnostic.providerOrder).not.toContain("deepseek");
    expect(diagnostic.terminalProvider).toBe("openai");
  });
});
