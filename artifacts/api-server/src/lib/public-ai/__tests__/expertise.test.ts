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

  it("detects accounting and prefers it over personal finance", () => {
    expect(
      detectOraExpertiseDomain("what journal entry records this on the balance sheet", "general"),
    ).toBe("accounting");
    expect(
      detectOraExpertiseDomain("how do I handle accounts payable at month-end close", "general"),
    ).toBe("accounting");
    expect(
      detectOraExpertiseDomain("under GAAP how should I report deferred revenue", "general"),
    ).toBe("accounting");
  });

  it("detects process improvement and prefers it over generic operations", () => {
    expect(detectOraExpertiseDomain("run a Six Sigma DMAIC on our intake", "general")).toBe(
      "process_improvement",
    );
    expect(
      detectOraExpertiseDomain("how do I reduce the bottleneck in our process", "general"),
    ).toBe("process_improvement");
    expect(detectOraExpertiseDomain("who owns this support queue handoff", "general")).toBe(
      "operations",
    );
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

  it("injects senior-accountant guidance and a CPA caveat for accounting topics", () => {
    const accounting = buildOraExpertiseProfile({
      message: "what journal entry records accrued payroll on the balance sheet",
      topic: "general",
      planTier: "core",
      routeTier: "premium",
      intent: "premium",
      confidence: "high",
    });

    expect(accounting.domain).toBe("accounting");
    expect(accounting.systemAddendum).toContain("senior accountant");
    expect(accounting.systemAddendum).toContain("general accounting information");
    expect(accounting.systemAddendum).toContain("licensed CPA");
  });

  it("injects Lean/Six Sigma guidance for process improvement topics", () => {
    const process = buildOraExpertiseProfile({
      message: "use DMAIC to reduce the bottleneck and cycle time in our intake process",
      topic: "general",
      planTier: "core",
      routeTier: "premium",
      intent: "premium",
      confidence: "high",
    });

    expect(process.domain).toBe("process_improvement");
    expect(process.systemAddendum).toContain("Lean/Six Sigma");
    expect(process.systemAddendum).toContain("current-state");
    expect(process.systemAddendum).toContain("control plan");
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
