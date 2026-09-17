import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasUsableZeroPlan, hasCompleteGeneratedZeroPlan } from "@workspace/ora-contracts";
vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
vi.mock("./planning-brain", () => ({ runPlanningBrain: vi.fn() }));
import { runPlanningBrain } from "./planning-brain";
import { runPlanPipeline } from "./builder";

const valid = () => ({
  goal: "Preserve private drafts",
  approach: "Keep unsaved form text in scoped per-tab storage.",
  sitemap: [{ name: "Note", route: "/notes/new", purpose: "Write a note" }],
  uxNotes: { Note: "Preserve unsaved values without automatic submission." },
  complexityScore: 3,
  recommendedMode: "eco",
  estimatedBuildSeconds: 25,
});
const args = {
  projectName: "Test notebook",
  projectKind: "web",
  userPrompt: "Preserve drafts",
  agentMode: "eco" as const,
};
beforeEach(() => {
  vi.mocked(runPlanningBrain).mockReset();
});

describe("usable plan artifact contract", () => {
  it.each([
    null,
    undefined,
    {},
    [],
    { intent: "plan", terminalRef: { taskId: 345 } },
    { goal: " ", approach: "Do work" },
    { goal: "Goal", approach: "" },
    { ...valid(), kind: "error" },
    { ...valid(), sitemap: [{}] },
    { ...valid(), keysNeeded: "KEY" },
    { ...valid(), estimatedBuildSeconds: Infinity },
  ])("rejects non-executable or malformed payload %j", (input) => {
    expect(hasUsableZeroPlan(input)).toBe(false);
  });
  it("accepts substantive legacy plans without inventing missing estimates", () => {
    const legacy = { goal: "Update notes", approach: "Keep the existing app.", pages: ["Notes"] };
    expect(hasUsableZeroPlan(legacy)).toBe(true);
    expect(hasCompleteGeneratedZeroPlan(legacy)).toBe(false);
  });
  it.each([{ complexityScore: 1.5 }, { estimatedBuildSeconds: 25.5 }])(
    "preserves safe legacy numeric metadata without accepting it for a new generated plan: %j",
    (metadata) => {
      const legacy = { ...valid(), ...metadata };
      expect(hasUsableZeroPlan(legacy)).toBe(true);
      expect(hasCompleteGeneratedZeroPlan(legacy)).toBe(false);
    },
  );
  it("accepts terminal metadata only alongside actual plan content without mutating input", () => {
    const plan = Object.freeze({ ...valid(), intent: "plan", terminalRef: { taskId: 343 } });
    expect(hasCompleteGeneratedZeroPlan(plan)).toBe(true);
    expect(plan).not.toHaveProperty("pages");
  });
});

describe("plan pipeline completion honesty", () => {
  it("returns a valid plan and derives compatible pages", async () => {
    vi.mocked(runPlanningBrain).mockResolvedValue(valid());
    const result = await runPlanPipeline(args);
    expect(result.plan?.pages).toEqual(["Note"]);
    expect(runPlanningBrain).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { intent: "plan" }, { ...valid(), sitemap: [{}] }])(
    "corrects an invalid first result exactly once: %j",
    async (invalid) => {
      vi.mocked(runPlanningBrain).mockResolvedValueOnce(invalid).mockResolvedValueOnce(valid());
      expect((await runPlanPipeline(args)).plan?.goal).toBe("Preserve private drafts");
      expect(runPlanningBrain).toHaveBeenCalledTimes(2);
    },
  );
  it("fails rather than emitting success when the bounded correction is still invalid", async () => {
    vi.mocked(runPlanningBrain).mockResolvedValue({ intent: "plan" });
    await expect(runPlanPipeline(args)).rejects.toThrow("usable plan");
    expect(runPlanningBrain).toHaveBeenCalledTimes(2);
  });
  it("fails on provider error rather than returning the old generic plan-ready message", async () => {
    vi.mocked(runPlanningBrain).mockRejectedValue(new Error("provider unavailable"));
    await expect(runPlanPipeline(args)).rejects.toThrow("usable plan");
    expect(runPlanningBrain).toHaveBeenCalledTimes(1);
  });
  it("preserves cancellation without another model request", async () => {
    const controller = new AbortController();
    const error = new Error("cancelled");
    vi.mocked(runPlanningBrain).mockImplementationOnce(async () => {
      controller.abort();
      throw error;
    });
    await expect(runPlanPipeline({ ...args, signal: controller.signal })).rejects.toBe(error);
    expect(runPlanningBrain).toHaveBeenCalledTimes(1);
  });
  it.each(["web", "mobile-ios", "mobile-android", "mobile-cross"])(
    "uses complete, privacy-aware plan requirements for %s",
    async (projectKind) => {
      vi.mocked(runPlanningBrain).mockResolvedValue(valid());
      await runPlanPipeline({ ...args, projectKind });
      const prompt = vi.mocked(runPlanningBrain).mock.calls[0]![0].systemPrompt;
      for (const field of [
        "sitemap",
        "uxNotes",
        "complexityScore",
        "recommendedMode",
        "estimatedBuildSeconds",
      ]) {
        expect(prompt).toContain(field);
      }
      expect(prompt).toContain("private form drafts");
    },
  );
});
