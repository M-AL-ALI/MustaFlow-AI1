import { describe, expect, it } from "vitest";
import { routeOraMessage, detectMemorySaveCandidate } from "../orchestrator";
import { buildOraRoutingDiagnostic } from "../routing-diagnostics";
import { detectFileRequest, isPastedReferenceAnalysisRequest, ORA_SYSTEM_PROMPT } from "../prompt";

const technicalClassifier = {
  intent: "premium",
  confidence: "high",
  topic: "technical",
  reason: "Software troubleshooting request.",
} as const;

const premiumClassifier = {
  intent: "premium",
  confidence: "high",
  topic: "general",
  reason: "Complex technical analysis.",
} as const;

const copiedReplitCodexReport = `Codex says:
Pulling latest Ora routing changes.
model-router.test.ts: 43/43 PASS
ora-image-edit.test.ts: 8/8 PASS
api-server typecheck: clean
One issue: formatter changed model-router.ts only.

Replit says:
quality-gate PASS
format PASS
lint PASS
codegen-drift PASS

What should I tell Replit?`;

const pastedErrorLog = `Replit build failed:
src/routes/public-ai/chat.ts:421:19 - error TS2339: Property 'imageId' does not exist on type 'ChatReply'.
src/hooks/use-ora-chat.ts:1294:25 - error TS2322: Type 'number | undefined' is not assignable to type 'number'.
vitest src/routes/public-ai/__tests__/ora-image-edit.test.ts: 1 failed, 7 passed
quality-gate FAILED

Can you explain the likely issue and what I should tell Codex?`;

describe("Ora conversation smoke matrix", () => {
  it("treats copied Replit/Codex reports as evidence to analyze, not as artifact requests", async () => {
    expect(isPastedReferenceAnalysisRequest(copiedReplitCodexReport)).toBe(true);
    expect(detectFileRequest(copiedReplitCodexReport)).toBeNull();

    const decision = await routeOraMessage({
      message: copiedReplitCodexReport,
      mode: "instant",
      classifier: premiumClassifier,
    });

    expect(decision.tool).toBe("answer");
    expect(decision.intent).toBe("premium");
    expect(decision.reason).toContain("pasted tool/workflow output");

    const diagnostic = await buildOraRoutingDiagnostic({
      message: copiedReplitCodexReport,
      subscriptionTier: "core",
      classifier: premiumClassifier,
    });

    expect(diagnostic.tool).toBe("answer");
    expect(diagnostic.routeTier).toBe("premium");
    expect(diagnostic.providerOrder.at(-1)).toBe("openai");
  });

  it("routes pasted error logs to direct technical analysis with the full visible log preserved", async () => {
    expect(isPastedReferenceAnalysisRequest(pastedErrorLog)).toBe(true);
    expect(detectFileRequest(pastedErrorLog)).toBeNull();

    const decision = await routeOraMessage({
      message: pastedErrorLog,
      mode: "instant",
      classifier: technicalClassifier,
    });

    expect(decision.tool).toBe("answer");
    expect(decision.intent).toBe("premium");
    expect(decision.reason).toContain("pasted tool/workflow output");

    expect(ORA_SYSTEM_PROMPT).toContain("read and reason over the full pasted content");
    expect(ORA_SYSTEM_PROMPT).toContain("answer with the exact short message first");
    expect(ORA_SYSTEM_PROMPT).toContain("Use only the minimum useful steps");
  });

  it("keeps explicit file, image, and search requests on their own tool paths", async () => {
    const fileDecision = await routeOraMessage({
      message: "Create an XLSX checklist for validating Ora routing changes.",
      mode: "instant",
    });
    expect(fileDecision.tool).toBe("file_generation");
    expect(fileDecision.fileFormat).toBe("xlsx");

    const imageDiagnostic = await buildOraRoutingDiagnostic({
      message: "Create a clean logo for my mobile mechanic app.",
      subscriptionTier: "core",
    });
    expect(imageDiagnostic.tool).toBe("image_generation");
    expect(imageDiagnostic.quotaKind).toBe("image");
    expect(imageDiagnostic.image).toMatchObject({ kind: "logo", aspectRatio: "1:1" });

    const searchDiagnostic = await buildOraRoutingDiagnostic({
      message:
        "Search the web for a detailed breakdown of the latest Vercel deployment outage status.",
      subscriptionTier: "wave",
    });
    expect(searchDiagnostic.tool).toBe("search");
    expect(searchDiagnostic.searchProfile?.depth).toBe("research");
    expect(searchDiagnostic.searchProfile?.sourceLimit).toBeGreaterThan(0);
  });

  it("keeps memory recall conversational while detecting durable facts worth saving", async () => {
    const recallDecision = await routeOraMessage({
      message: "What answer style did I ask you to remember?",
      mode: "instant",
      classifier: premiumClassifier,
    });

    expect(recallDecision.tool).toBe("answer");

    const candidate = detectMemorySaveCandidate(
      "Remember that I prefer direct answers with minimum steps.",
    );

    expect(candidate).toMatchObject({
      fact: "I prefer direct answers with minimum steps.",
      confidence: "high",
      sensitive: false,
      category: "preference",
    });
  });
});
