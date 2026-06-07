import { describe, expect, it } from "vitest";
import { buildOraxTaskPlan, parseRepositoryLocator } from "../orax";

describe("ORAX repository locator parsing", () => {
  it("parses GitHub HTTPS repository URLs", () => {
    expect(
      parseRepositoryLocator({
        repositoryUrl: "https://github.com/M-AL-ALI/MustaFlow-AI1.git",
        defaultBranch: "main",
      }),
    ).toEqual({
      provider: "github",
      owner: "M-AL-ALI",
      name: "MustaFlow-AI1",
      repositoryUrl: "https://github.com/M-AL-ALI/MustaFlow-AI1",
      defaultBranch: "main",
    });
  });

  it("parses SSH-style GitHub URLs without storing credentials", () => {
    expect(
      parseRepositoryLocator({
        repositoryUrl: "git@github.com:M-AL-ALI/MustaFlow-AI1.git",
      }),
    ).toMatchObject({
      provider: "github",
      owner: "M-AL-ALI",
      name: "MustaFlow-AI1",
      repositoryUrl: "https://github.com/M-AL-ALI/MustaFlow-AI1",
      defaultBranch: "main",
    });
  });

  it("rejects repository locators without owner and name", () => {
    expect(() => parseRepositoryLocator({ repositoryUrl: "https://github.com/M-AL-ALI" })).toThrow(
      "owner and repository name",
    );
  });
});

describe("ORAX safe task plan", () => {
  it("keeps write, terminal, push, and deployment actions locked", () => {
    const plan = buildOraxTaskPlan({
      kind: "fix",
      repository: {
        provider: "github",
        owner: "M-AL-ALI",
        name: "MustaFlow-AI1",
        defaultBranch: "main",
      },
      prompt: "Fix the voice playback bug",
    });

    expect(plan.mode).toBe("read_only_foundation");
    expect(plan.objective).toBe("Fix the voice playback bug");
    expect(plan.guardrails.join(" ")).toContain("separate from Ora chat memory and AI Builder");
    expect(plan.unavailableUntilApproved).toEqual(
      expect.arrayContaining(["File modifications", "Terminal execution", "Git push"]),
    );
  });
});
