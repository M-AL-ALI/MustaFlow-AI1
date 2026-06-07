import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOraxTaskPlan, parseRepositoryLocator } from "../orax";
import { extensionToLanguage, summarizeGithubTree } from "../orax-github";

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
