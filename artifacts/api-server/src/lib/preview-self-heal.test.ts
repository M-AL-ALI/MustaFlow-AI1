import { describe, expect, it } from "vitest";
import {
  buildPreviewRepairObservation,
  classifyQAErrors,
  classifyRuntimeLogLines,
  previewSelfHealEnabled,
  resolvePreviewSelfHealBudget,
} from "./preview-self-heal";

describe("preview self-heal signal classification", () => {
  it("detects boot crashes and unhandled exceptions without treating healthy logs as errors", () => {
    const issues = classifyRuntimeLogLines([
      { level: "stdout", message: "[vite] hmr update /src/App.tsx" },
      { level: "stderr", message: "0 errors found" },
      { level: "stderr", message: "Process exited with status 0" },
      { level: "stderr", message: "FATAL: process exited with code 1" },
      { level: "stderr", message: "Unhandled TypeError: cannot read properties of undefined" },
    ]);
    expect(issues).toMatchObject([
      { kind: "boot_crash", source: "container_log" },
      { kind: "server_exception", source: "container_log" },
    ]);
  });

  it("classifies blank pages and browser exceptions but treats a missing QA runner as unavailable", () => {
    const result = classifyQAErrors([
      "Preview rendered a blank page",
      "JS error: Widget is not defined",
      "QA runner failed: no chromium binary available",
    ]);
    expect(result.issues.map((issue) => issue.kind)).toEqual(["blank_page", "browser_exception"]);
    expect(result.unavailableChecks).toHaveLength(1);
  });

  it("renders a bounded observation for Zero and defaults the kill switch on", () => {
    const text = buildPreviewRepairObservation({
      issues: [
        {
          kind: "boot_crash",
          source: "container_log",
          message: "Process exited with code 1",
        },
      ],
      inspectedLogLines: 7,
      qaErrors: 0,
      unavailableChecks: [],
    });
    expect(text).toContain("[boot_crash/container_log] Process exited with code 1");
    expect(text).toContain("Do not add features");
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(previewSelfHealEnabled({})).toBe(true);
    expect(previewSelfHealEnabled({ ZERO_PREVIEW_SELF_HEAL_ENABLED: "false" })).toBe(false);
  });

  it("never gives the repair cycle more than the original task's unused budget", () => {
    expect(
      resolvePreviewSelfHealBudget({
        stepsUsed: 19,
        stepCap: 25,
        taskElapsedMs: 9 * 60_000,
        wallClockBudgetMs: 12 * 60_000,
      }),
    ).toEqual({
      stepBudget: 6,
      wallClockBudgetMs: 3 * 60_000,
      remainingSteps: 6,
      remainingWallClockMs: 3 * 60_000,
      canAttempt: true,
    });
    expect(
      resolvePreviewSelfHealBudget({
        stepsUsed: 25,
        stepCap: 25,
        taskElapsedMs: 30_000,
        wallClockBudgetMs: 12 * 60_000,
      }).canAttempt,
    ).toBe(false);
  });
});
