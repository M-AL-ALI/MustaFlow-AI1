import { describe, expect, it } from "vitest";
import {
  buildOraExpertiseProfile,
  detectOraExpertiseDomain,
  resolveOraAnswerDepth,
} from "../expertise";

describe("detectOraExpertiseDomain", () => {
  it("uses classifier topics for platform/product domains", () => {
    expect(detectOraExpertiseDomain("help me plan this", "app-planning")).toBe("product_strategy");
    expect(detectOraExpertiseDomain("how should pricing work", "saas")).toBe("business_strategy");
    expect(detectOraExpertiseDomain("debug this query", "technical")).toBe("software_engineering");
  });

  it("detects regulated and specialist domains from the message", () => {
    expect(detectOraExpertiseDomain("can you review this contract risk", "general")).toBe("legal");
    expect(detectOraExpertiseDomain("help me compare investment options", "general")).toBe(
      "finance",
    );
    expect(detectOraExpertiseDomain("what could these symptoms mean", "general")).toBe("health");
    expect(detectOraExpertiseDomain("analyze this CSV trend", "general")).toBe("data_analysis");
  });

  it("lets regulated-domain guidance win over broad classifier topics", () => {
    expect(detectOraExpertiseDomain("is this pricing contract legally risky", "pricing")).toBe(
      "legal",
    );
    expect(detectOraExpertiseDomain("debug these medical symptoms", "technical")).toBe("health");
  });
});

describe("resolveOraAnswerDepth", () => {
  it("keeps simple FAQ concise regardless of paid plan", () => {
    expect(
      resolveOraAnswerDepth({
        planTier: "wave",
        routeTier: "fast",
        intent: "simple_faq",
        confidence: "high",
      }),
    ).toBe("concise");
  });

  it("upgrades substantive Wave answers to expert and deep mode to deep", () => {
    expect(
      resolveOraAnswerDepth({
        planTier: "wave",
        routeTier: "premium",
        intent: "premium",
        confidence: "high",
      }),
    ).toBe("expert");
    expect(
      resolveOraAnswerDepth({
        planTier: "core",
        routeTier: "deep",
        intent: "premium",
        confidence: "high",
      }),
    ).toBe("deep");
  });
});

describe("buildOraExpertiseProfile", () => {
  it("gives paid technical answers a larger budget than free answers", () => {
    const base = {
      message: "debug a Node API performance issue",
      topic: "technical" as const,
      routeTier: "premium" as const,
      intent: "premium" as const,
      confidence: "high" as const,
    };

    const free = buildOraExpertiseProfile({ ...base, planTier: "free" });
    const core = buildOraExpertiseProfile({ ...base, planTier: "core" });
    const wave = buildOraExpertiseProfile({ ...base, planTier: "wave" });

    expect(free.domain).toBe("software_engineering");
    expect(core.maxTokens).toBeGreaterThan(free.maxTokens);
    expect(wave.maxTokens).toBeGreaterThan(core.maxTokens);
    expect(wave.depth).toBe("expert");
  });

  it("injects safety guidance for regulated topics", () => {
    const legal = buildOraExpertiseProfile({
      message: "is this contract clause legal",
      topic: "general",
      planTier: "core",
      routeTier: "premium",
      intent: "premium",
      confidence: "high",
    });

    expect(legal.domain).toBe("legal");
    expect(legal.systemAddendum).toContain("general legal information");
    expect(legal.systemAddendum).toContain("not legal advice");
  });

  it("adds document-context budget for document-heavy expert answers", () => {
    const withoutDocs = buildOraExpertiseProfile({
      message: "summarize the main risks",
      topic: "general",
      planTier: "core",
      routeTier: "premium",
      intent: "premium",
      confidence: "high",
      hasDocumentContext: false,
    });
    const withDocs = buildOraExpertiseProfile({
      message: "summarize the main risks",
      topic: "general",
      planTier: "core",
      routeTier: "premium",
      intent: "premium",
      confidence: "high",
      hasDocumentContext: true,
    });

    expect(withDocs.maxTokens).toBeGreaterThan(withoutDocs.maxTokens);
  });
});
