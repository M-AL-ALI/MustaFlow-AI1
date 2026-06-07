import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOraxTaskPlan, normalizeOraxFileReadPaths, parseRepositoryLocator } from "../orax";
import { buildDraftPatchPrompt, parseDraftPatchJson } from "../orax-draft-patch";
import { extensionToLanguage, summarizeGithubTree } from "../orax-github";
import { runOraxSandboxValidation } from "../orax-sandbox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

describe("ORAX read-only GitHub scan summaries", () => {
  it("summarizes repository trees without source file contents", () => {
    const summary = summarizeGithubTree({
      owner: "M-AL-ALI",
      name: "MustaFlow-AI1",
      branch: "main",
      commitSha: "abc123",
      repo: {
        default_branch: "main",
        full_name: "M-AL-ALI/MustaFlow-AI1",
        html_url: "https://github.com/M-AL-ALI/MustaFlow-AI1",
        private: true,
        language: "TypeScript",
        size: 100,
        pushed_at: "2026-06-07T00:00:00Z",
      },
      tree: {
        sha: "abc123",
        truncated: false,
        tree: [
          {
            path: "src",
            mode: "040000",
            type: "tree",
            sha: "dir",
            url: "https://api.github.com/tree/dir",
          },
          {
            path: "src/index.ts",
            mode: "100644",
            type: "blob",
            sha: "file1",
            size: 120,
            url: "https://api.github.com/blob/file1",
          },
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "file2",
            size: 80,
            url: "https://api.github.com/blob/file2",
          },
        ],
      },
    });

    expect(summary.fileCount).toBe(2);
    expect(summary.directoryCount).toBe(1);
    expect(summary.totalBytes).toBe(200);
    expect(summary.languages).toEqual({ TypeScript: 1, JSON: 1 });
    expect(summary.sampleFiles).toEqual(["package.json", "src/index.ts"]);
    expect(JSON.stringify(summary)).not.toContain("source code");
  });

  it("maps common extensions for scan language summaries", () => {
    expect(extensionToLanguage("app/page.tsx")).toBe("TypeScript");
    expect(extensionToLanguage("server.py")).toBe("Python");
    expect(extensionToLanguage("README.md")).toBe("Markdown");
    expect(extensionToLanguage("LICENSE")).toBeNull();
  });

  it("keeps the GitHub helper read-only", () => {
    const source = readFileSync(path.join(__dirname, "../orax-github.ts"), "utf8");
    expect(source).toContain('method: "GET"');
    expect(source).not.toMatch(/method:\s*"POST"/);
    expect(source).not.toMatch(/method:\s*"PATCH"/);
    expect(source).not.toMatch(/method:\s*"PUT"/);
    expect(source).not.toMatch(/method:\s*"DELETE"/);
  });
});

describe("ORAX approval-gated file path validation", () => {
  it("normalizes repository-relative file paths", () => {
    expect(normalizeOraxFileReadPaths([" src/index.ts ", "src\\app.ts", "src/index.ts"])).toEqual([
      "src/index.ts",
      "src/app.ts",
    ]);
  });

  it("rejects absolute paths and traversal", () => {
    expect(() => normalizeOraxFileReadPaths(["../secrets.env"])).toThrow("traversal");
    expect(() => normalizeOraxFileReadPaths(["/etc/passwd"])).toThrow("repository-relative");
    expect(() => normalizeOraxFileReadPaths(["C:/Users/Admin/.ssh/id_rsa"])).toThrow(
      "repository-relative",
    );
  });

  it("limits the number of files in one approval request", () => {
    expect(() =>
      normalizeOraxFileReadPaths(Array.from({ length: 13 }, (_, index) => `src/${index}.ts`)),
    ).toThrow("At most 12 files");
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

describe("ORAX draft patch previews", () => {
  it("parses strict JSON draft patch model output", () => {
    expect(
      parseDraftPatchJson(`{
        "summary": "Fix preview playback",
        "explanation": "Updates one condition.",
        "unifiedDiff": "diff --git a/a.ts b/a.ts",
        "risks": ["Could miss an edge case"],
        "tests": ["pnpm test"]
      }`),
    ).toEqual({
      summary: "Fix preview playback",
      explanation: "Updates one condition.",
      unifiedDiff: "diff --git a/a.ts b/a.ts",
      risks: ["Could miss an edge case"],
      tests: ["pnpm test"],
    });
  });

  it("keeps generated patch prompts preview-only", () => {
    const prompt = buildDraftPatchPrompt({
      repositoryLabel: "M-AL-ALI/MustaFlow-AI1",
      taskPrompt: "Fix a bug",
      branch: "main",
      files: [
        {
          path: "src/app.ts",
          content: "export const value = 1;",
          size: 23,
          sha: "abc123",
        },
      ],
    });

    expect(prompt).toContain("Produce a reviewable unified diff preview only");
    expect(prompt).toContain("Do not claim any file was changed");
    expect(prompt).toContain("Do not include shell commands that mutate files");
    expect(prompt).toContain("Do not suggest pushing, deploying, or opening a PR");
    expect(prompt).toContain("Keep the diff scoped to approved files only");
  });
});

describe("ORAX sandbox validation", () => {
  it("applies a draft patch to approved file content in memory", () => {
    const result = runOraxSandboxValidation({
      unifiedDiff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 export const name = "Ora";
-export const enabled = false;
+export const enabled = true;`,
      files: [
        {
          path: "src/app.ts",
          content: 'export const name = "Ora";\nexport const enabled = false;',
          size: 59,
          sha: "abc123",
        },
      ],
      suggestedTests: ["pnpm test"],
    });

    expect(result.applied).toBe(true);
    expect(result.changedFiles).toEqual([
      expect.objectContaining({ path: "src/app.ts", additions: 1, deletions: 1 }),
    ]);
    expect(result.testPreview).toEqual([
      expect.objectContaining({
        name: "pnpm test",
        status: "not_run",
      }),
    ]);
  });

  it("rejects patches outside the approved file set", () => {
    const result = runOraxSandboxValidation({
      unifiedDiff: `diff --git a/src/secret.ts b/src/secret.ts
--- a/src/secret.ts
+++ b/src/secret.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;`,
      files: [
        {
          path: "src/app.ts",
          content: "export const value = 1;",
          size: 23,
          sha: "abc123",
        },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.errors.join(" ")).toContain("outside the approved file set");
  });
});
