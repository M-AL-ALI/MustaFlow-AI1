import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldRetryEmptyRefine } from "./empty-refine-retry-policy";

const unchanged = {
  usesAgentLoop: true,
  specializedStaticProject: false,
  changedFilesCount: 0,
  removedPathsCount: 0,
};

describe("empty refine retry policy", () => {
  it.each([
    "Retry the supported Pantry/Kitchen build exactly once. Preserve the current files.",
    "Run validation and fix only evidenced errors if necessary.",
    "Add a notes dashboard and connect the database.",
    "Build the app from the existing files without changes.",
    "How do I build the app?",
    "Rerun the existing checks.",
  ])("does not restart a bounded agent loop for %s", (userPrompt) => {
    expect(shouldRetryEmptyRefine({ ...unchanged, userPrompt })).toBe(false);
  });

  it.each([
    { usesAgentLoop: false, specializedStaticProject: false },
    { usesAgentLoop: false, specializedStaticProject: true },
    { usesAgentLoop: true, specializedStaticProject: true },
  ])("retains the legacy retry policy for %j", (pipeline) => {
    expect(
      shouldRetryEmptyRefine({ ...unchanged, ...pipeline, userPrompt: "Add a contact form" }),
    ).toBe(true);
  });

  it.each([
    { changedFilesCount: 1, removedPathsCount: 0 },
    { changedFilesCount: 0, removedPathsCount: 1 },
    { changedFilesCount: 1, removedPathsCount: 1 },
  ])("never repeats a legacy pass that already changed files: %j", (changes) => {
    expect(
      shouldRetryEmptyRefine({
        ...unchanged,
        ...changes,
        usesAgentLoop: false,
        userPrompt: "Update the home page",
      }),
    ).toBe(false);
  });

  it.each(["How do I build this?", "Explain how to build this", "Could you build this?", "Thanks"])(
    "preserves legacy question/explanation exclusions for %s",
    (userPrompt) => {
      expect(shouldRetryEmptyRefine({ ...unchanged, usesAgentLoop: false, userPrompt })).toBe(
        false,
      );
    },
  );

  it("wires the policy to actual pipeline and file outcomes before the retry", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(source).toContain("if (\n          shouldRetryEmptyRefine({");
    expect(source).toContain("usesAgentLoop: USE_AGENT_LOOP_REFINE");
    expect(source).toContain("specializedStaticProject: isSpecializedStaticProject");
    expect(source).toContain("changedFilesCount: refineResult.changedFiles.length");
    expect(source).toContain("removedPathsCount: refineResult.removedPaths.length");
    expect(source).not.toContain(
      "if (refineEmpty && BUILD_VERB_RE.test(userPrompt) && !isQuestion)",
    );
  });
});
