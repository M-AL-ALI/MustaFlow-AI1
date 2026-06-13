import { describe, expect, it } from "vitest";
import { evaluateOraResponseQuality } from "../response-quality";

describe("Ora response quality evaluator", () => {
  it("passes direct Replit/Codex pasted-report answers", () => {
    const result = evaluateOraResponseQuality({
      scenario: "pasted_report",
      userMessage: `Codex says tests pass.
Replit says quality-gate pass.
What should I tell Replit?`,
      reply:
        "Tell Replit: pull the latest commit and run the canonical checks. Codex already verified the routing tests, so the next step is Replit confirmation.",
      suggestions: [],
    });

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
  });

  it("fails pasted-report answers that drift into generic suggestions or artifacts", () => {
    const result = evaluateOraResponseQuality({
      scenario: "pasted_report",
      userMessage: `Replit says typecheck passed.
Codex says formatter changed model-router.ts.
What should I tell Replit?`,
      reply:
        "Sure, here are some suggestions. I created a spreadsheet with the next steps for you to download.",
      fileName: "next-steps.xlsx",
      fileData: "ZmFrZQ==",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(80);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["not_direct", "wrong_artifact_path", "missing_tool_actor"]),
    );
  });

  it("blocks raw provider errors from being treated as acceptable answers", () => {
    const result = evaluateOraResponseQuality({
      scenario: "general",
      userMessage: "Can you help me plan my app?",
      reply: "DeepSeek error: insufficient balance. [object Object]",
    });

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("raw_provider_error");
  });

  it("requires complete file payloads for file-generation answers", () => {
    const failed = evaluateOraResponseQuality({
      scenario: "file_generation",
      userMessage: "Create an XLSX checklist for validating Ora routing changes.",
      reply: "Created the XLSX checklist. Download it from the file card.",
      fileName: "ora-routing-checklist.xlsx",
    });

    expect(failed.passed).toBe(false);
    expect(failed.issues.map((issue) => issue.code)).toContain("missing_file_payload");

    const passed = evaluateOraResponseQuality({
      scenario: "file_generation",
      userMessage: "Create an XLSX checklist for validating Ora routing changes.",
      reply: "Created the XLSX checklist.",
      fileName: "ora-routing-checklist.xlsx",
      fileData: "ZmFrZQ==",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(passed.passed).toBe(true);
  });

  it("checks image-generation claims for signed-in and anonymous users", () => {
    const signedInFailed = evaluateOraResponseQuality({
      scenario: "image_generation",
      signedIn: true,
      userMessage: "Create a clean logo for my mobile mechanic app.",
      reply: "Here's the image you asked for.",
    });

    expect(signedInFailed.passed).toBe(false);
    expect(signedInFailed.issues.map((issue) => issue.code)).toContain("missing_image_url");

    const anonymousFailed = evaluateOraResponseQuality({
      scenario: "image_generation",
      signedIn: false,
      userMessage: "Create a clean logo for my mobile mechanic app.",
      reply: "I cannot generate images.",
    });

    expect(anonymousFailed.passed).toBe(false);
    expect(anonymousFailed.issues.map((issue) => issue.code)).toContain(
      "bad_image_capability_claim",
    );
  });

  it("scores memory recall only when the answer and memory signal agree", () => {
    const failed = evaluateOraResponseQuality({
      scenario: "memory_recall",
      userMessage: "What answer style did I ask you to remember?",
      reply: "I do not have that saved.",
    });

    expect(failed.passed).toBe(false);
    expect(failed.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing_memory_signal", "weak_memory_answer"]),
    );

    const passed = evaluateOraResponseQuality({
      scenario: "memory_recall",
      userMessage: "What answer style did I ask you to remember?",
      reply: "You prefer direct answers with minimum steps.",
      memoriesUsed: [{ id: 42, title: "Answer style" }],
    });

    expect(passed.passed).toBe(true);
    expect(passed.score).toBe(100);
  });
});
