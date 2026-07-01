import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOraxTaskPlan, normalizeOraxFileReadPaths, parseRepositoryLocator } from "../orax";
import {
  hasOraxWorkspaceCommandIds,
  normalizeOraxSandboxCommandIds,
  runOraxControlledSandboxChecks,
  runOraxIsolatedWorkspaceChecks,
} from "../orax-command-sandbox";
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

  it("keeps GitHub writes scoped to branch and PR creation", () => {
    const source = readFileSync(path.join(__dirname, "../orax-github.ts"), "utf8");
    expect(source).toMatch(/method:\s*(?:options\?\.method\s*\?\?\s*)?"GET"/);
    expect(source).toContain('method: "POST"');
    expect(source).toContain("/git/blobs");
    expect(source).toContain("/git/trees");
    expect(source).toContain("/git/commits");
    expect(source).toContain("/git/refs");
    expect(source).toContain("/pulls");
    expect(source).not.toMatch(/method:\s*"PATCH"/);
    expect(source).not.toMatch(/method:\s*"PUT"/);
    expect(source).not.toMatch(/method:\s*"DELETE"/);
    expect(source).not.toContain("child_process");
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

describe("ORAX controlled sandbox checks", () => {
  it("does not accept arbitrary command strings or shell execution", () => {
    const source = readFileSync(path.join(__dirname, "../orax-command-sandbox.ts"), "utf8");
    expect(source).toContain("execFile");
    expect(source).toContain("process.execPath");
    expect(source).toContain("--check");
    expect(source).toContain("corepack");
    expect(source).toContain('"pnpm", "run", "typecheck"');
    expect(source).toContain('"pnpm", "run", "lint"');
    expect(source).toContain('"pnpm", "test"');
    expect(source).toContain('"pnpm", "run", "build"');
    expect(source).not.toContain("exec(");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("shell:");
    expect(source).not.toContain("rm -rf");
    expect(source).not.toContain("yarn");
  });

  it("rejects arbitrary or destructive command names", () => {
    expect(() => normalizeOraxSandboxCommandIds(["pnpm test"])).toThrow(
      "Unsupported ORAX sandbox command",
    );
    expect(() => normalizeOraxSandboxCommandIds(["rm -rf /"])).toThrow(
      "Unsupported ORAX sandbox command",
    );
  });

  it("accepts only fixed workspace package-check command IDs", () => {
    const commands = normalizeOraxSandboxCommandIds([
      "patch-static-checks",
      "pnpm-typecheck",
      "pnpm-lint",
      "pnpm-test",
      "pnpm-build",
    ]);

    expect(commands).toEqual([
      "patch-static-checks",
      "pnpm-typecheck",
      "pnpm-lint",
      "pnpm-test",
      "pnpm-build",
    ]);
    expect(hasOraxWorkspaceCommandIds(commands)).toBe(true);
  });

  it("runs fixed controlled checks without repo package scripts", async () => {
    const result = await runOraxControlledSandboxChecks({
      commands: ["patch-static-checks", "json-syntax", "node-syntax"],
      staticChecks: [
        {
          name: "src/app.js: patch applies",
          status: "passed",
          message: "Patch applied.",
        },
      ],
      patchedFiles: [
        {
          path: "package.json",
          sourceSha: "abc",
          content: '{"name":"demo","scripts":{"test":"rm -rf /"}}',
        },
        {
          path: "src/app.js",
          sourceSha: "def",
          content: 'export const value = "safe";',
        },
      ],
    });

    expect(result.mode).toBe("controlled_sandbox_execution");
    expect(result.passed).toBe(true);
    expect(result.commands.map((command) => command.id)).toEqual([
      "patch-static-checks",
      "json-syntax",
      "node-syntax",
    ]);
    expect(JSON.stringify(result)).not.toContain("rm -rf /");
  });

  it("requires a repository archive before workspace package checks run", async () => {
    const result = await runOraxIsolatedWorkspaceChecks({
      commands: ["pnpm-typecheck"],
      staticChecks: [],
      patchedFiles: [
        {
          path: "src/app.ts",
          sourceSha: "abc",
          content: "export const value = 1;",
        },
      ],
    });

    expect(result.mode).toBe("isolated_workspace_execution");
    expect(result.passed).toBe(false);
    expect(result.commands[0]).toEqual(
      expect.objectContaining({
        id: "pnpm-typecheck",
        status: "failed",
      }),
    );
  });

  it("reports syntax failures as failed command results", async () => {
    const result = await runOraxControlledSandboxChecks({
      commands: ["node-syntax"],
      staticChecks: [],
      patchedFiles: [
        {
          path: "src/broken.js",
          sourceSha: "abc",
          content: "const value = ;",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.commands[0]).toEqual(
      expect.objectContaining({
        id: "node-syntax",
        status: "failed",
        exitCode: 1,
      }),
    );
  });
});

describe("ORAX GitHub PR approval hardening", () => {
  it("requires explicit PR confirmation and records the approval chain", () => {
    const source = readFileSync(path.join(__dirname, "../../routes/orax.ts"), "utf8");

    expect(source).toContain('confirmationText: z.literal("CREATE PR")');
    expect(source).toContain("buildOraxAuditTrail");
    expect(source).toContain("Read approval");
    expect(source).toContain("GitHub PR approval");
    expect(source).toContain(
      "Package checks, when present, were limited to approved ORAX command IDs",
    );
  });

  it("makes PR creation retry-safe and persists GitHub failures", () => {
    const source = readFileSync(path.join(__dirname, "../../routes/orax.ts"), "utf8");

    expect(source).toContain("findCompletedGithubPrArtifactForApproval");
    expect(source).toContain("findCompletedGithubPrArtifactForCommand");
    expect(source).toContain("buildOraxBranchName");
    expect(source).toContain("orax/task-${taskId}-check-${commandArtifactId}");
    expect(source).toContain("persistGithubPrFailure");
    expect(source).toContain('type: "github_pr_result"');
    expect(source).toContain('status: "failed"');
    expect(source).toContain("normalizeGithubPrFailure");
    expect(source).toContain("github_permission_error");
    expect(source).toContain("github_branch_exists");
  });
});

describe("ORAX task conversation isolation", () => {
  it("stores task chat in ORAX-owned messages and not normal Ora or Builder surfaces", () => {
    const routeSource = readFileSync(path.join(__dirname, "../../routes/orax.ts"), "utf8");
    const schemaSource = readFileSync(
      path.join(__dirname, "../../../../../lib/db/src/schema/orax.ts"),
      "utf8",
    );
    const migrationsSource = readFileSync(path.join(__dirname, "../startup-migrations.ts"), "utf8");
    const allOutstandingSource = readFileSync(
      path.join(__dirname, "../../../../../scripts/src/migrate-all-outstanding.ts"),
      "utf8",
    );

    expect(schemaSource).toContain("orax_task_messages");
    expect(schemaSource).toContain("oraxTaskMessagesTable");
    expect(migrationsSource).toContain("migrate-orax-messages");
    expect(allOutstandingSource).toContain('"migrate-orax-messages"');
    expect(routeSource).toContain('router.get("/orax/tasks/:id/messages"');
    expect(routeSource).toContain('router.get("/orax/tasks/:id/events"');
    expect(routeSource).toContain('"Content-Type": "text/event-stream"');
    expect(routeSource).toContain("loadOraxTaskMessagesAfter");
    expect(routeSource).toContain('writeEvent("message", { message }, message.id)');
    expect(routeSource).toContain("orax-task-timeline");
    expect(routeSource).toContain('router.post("/orax/tasks/:id/messages"');
    expect(routeSource).toContain("oraxTaskMessagesTable");
    expect(routeSource).toContain("buildOraxTaskThreadReply");
    expect(routeSource).toContain("I'll work from here.");
    expect(routeSource).toContain("composerMetadataSchema");
    expect(routeSource).toContain("composerAttachmentSchema");
    expect(routeSource).toContain('permissionMode: z.enum(["ask", "auto", "read_only"])');
    expect(routeSource).toContain(
      "attachments: z.array(composerAttachmentSchema).max(6).optional()",
    );
    expect(routeSource).toContain(
      'contentKind: z.enum(["text", "image", "binary", "unsupported"])',
    );
    expect(routeSource).toContain("contentText: z.string().max(120_000).optional()");
    expect(routeSource).toContain("dataUrl: z.string().max(1_500_000).optional()");
    expect(routeSource).toContain('ingestionStatus: z.enum(["ready", "unsupported", "error"])');
    expect(routeSource).toContain("normalizeOraxComposerAttachments");
    expect(routeSource).toContain("buildOraxComposerAttachmentContext");
    expect(routeSource).toContain("buildOraxComposerAttachmentAnalysis");
    expect(routeSource).toContain("enhanceOraxComposerAttachmentAnalysisWithAi");
    expect(routeSource).toContain("runOraxAiAttachmentAnalysis");
    expect(routeSource).toContain("resolveStageProvider");
    expect(routeSource).toContain("VISION_MODEL");
    expect(routeSource).toContain('type: "image_url"');
    expect(routeSource).toContain("aiSummary");
    expect(routeSource).toContain("aiStatus");
    expect(routeSource).toContain("buildOraxAttachmentAnalysisContext");
    expect(routeSource).toContain("extractOraxAttachmentErrorSignals");
    expect(routeSource).toContain("parseOraxImageDimensions");
    expect(routeSource).toContain("attachmentAnalysis");
    expect(routeSource).toContain("suggestedFocus");
    expect(routeSource).toContain("const attachmentAnalysisContext = attachmentAnalysis");
    expect(routeSource).toContain("const effectiveUserMessage = [");
    expect(routeSource).toContain("attachmentContext: userMessageContext");
    expect(routeSource).toContain("Image data URL for visual/UI context:");
    expect(routeSource).toContain("...(parsed.data.metadata ?? {})");
    expect(routeSource).toContain("composer: composerMetadata ?? null");
    expect(routeSource).not.toContain("Phase 4B is planning-only");
    expect(routeSource).not.toContain("I saved this in the ORAX task thread");
    expect(routeSource).toContain("buildOraxTaskActionSuggestions");
    expect(routeSource).toContain("actionSuggestions");
    expect(routeSource).toContain("Map task chat into approval-ready suggestions");
    expect(routeSource).toContain("Prepare approval requests from task-chat suggestions");
    expect(routeSource).toContain("persistent ORAX-only task conversation");
    expect(routeSource).toContain("requiresManualConfirmation");
    expect(routeSource).toContain('buttonLabel: "Validate patch"');
    expect(routeSource).toContain('buttonLabel: "Prepare pull request"');
    expect(routeSource).toContain("extractOraxCandidatePaths");
    expect(routeSource).toContain("persistOraxTimelineMessage");
    expect(routeSource).toContain("orax-task-timeline");
    expect(routeSource).toContain("persistOraxCheckpoint");
    expect(routeSource).toContain("buildOraxCheckpointSummary");
    expect(routeSource).toContain("orax-task-checkpoint");
    expect(routeSource).toContain("checkpoint_updated");
    expect(routeSource).toContain("currentCheckpoint");
    expect(routeSource).toContain("Request approval to read the relevant repository files.");
    expect(routeSource).toContain("isOraxResumeQuestion");
    expect(routeSource).toContain("buildOraxCheckpointResumeReply");
    expect(routeSource).toContain("resumeMode");
    expect(routeSource).not.toContain("Checkpoint next step:");
    expect(routeSource).not.toContain("Here is where this task stands.");
    expect(routeSource).not.toContain("Approvals: ${checkpoint.approvals.completed}");
    expect(routeSource).not.toContain("Artifacts: ${checkpoint.artifacts.total}");
    expect(routeSource).not.toContain("Invalid ORAX task");
    expect(routeSource).toContain("where are we");
    expect(routeSource).toContain("what happened");
    expect(routeSource).toContain("Next, I need to");
    expect(routeSource).toContain('event: "task_created"');
    expect(routeSource).toContain('event: "approval_requested"');
    expect(routeSource).toContain('event: "approval_decided"');
    expect(routeSource).toContain('event: "files_read"');
    expect(routeSource).toContain('event: "draft_patch_generated"');
    expect(routeSource).toContain('event: "sandbox_completed"');
    expect(routeSource).toContain('event: "checks_completed"');
    expect(routeSource).toContain('event: "pr_created"');
    expect(routeSource).toContain('event: "pr_failed"');
    expect(routeSource).toContain('router.post("/orax/tasks/:id/continue"');
    expect(routeSource).toContain("continueOraxTaskRunner");
    expect(routeSource).toContain("runner_continue");
    expect(routeSource).toContain('type: "execution_session"');
    expect(routeSource).toContain("ensureOraxExecutionSession");
    expect(routeSource).toContain("appendOraxExecutionSessionStep");
    expect(routeSource).toContain("persistOraxExecutionProgress");
    expect(routeSource).toContain("executionSessionId");
    expect(routeSource).toContain("executionStep");
    expect(routeSource).toContain("retry_failed_patch");
    expect(routeSource).toContain("findLatestOraxRetryableFailure");
    expect(routeSource).toContain("generateOraxRunnerRetryDraftPatch");
    expect(routeSource).toContain("findOraxRetryDraftForFailure");
    expect(routeSource).toContain("hasOraxValidationAfterDraft");
    expect(routeSource).toContain('type: "workspace_change_set"');
    expect(routeSource).toContain("createOraxRunnerWorkspaceChangeSet");
    expect(routeSource).toContain("findOraxWorkspaceChangeSetForSandbox");
    expect(routeSource).toContain("findPersistedOraxWorkspaceChangeSetForSandbox");
    expect(routeSource).toContain("buildOraxWorkspacePatchContext");
    expect(routeSource).toContain("workspaceChangeSetArtifactId");
    expect(routeSource).toContain("Preparing a reviewable workspace change set");
    expect(routeSource).toContain("Workspace change set ready");
    expect(routeSource).toContain("Reviewing the failed result and drafting a fix attempt");
    expect(routeSource).toContain("retryOfArtifactId");
    expect(routeSource).toContain("failureSummary");
    expect(routeSource).toContain("Orax started an execution session");
    expect(routeSource).toContain("Reading approved repository files...");
    expect(routeSource).toContain(
      "Running approved controlled checks in the isolated workspace...",
    );
    expect(routeSource).toContain("runOraxRunnerApprovedFileRead");
    expect(routeSource).toContain("runOraxRunnerApprovedSandbox");
    expect(routeSource).toContain("runOraxRunnerApprovedChecks");
    expect(routeSource).toContain("requestOraxRunnerFileReadApproval");
    expect(routeSource).toContain("requestOraxRunnerCommandApproval");
    expect(routeSource).toContain("Review approval #");
    expect(routeSource).toContain("Type CREATE PR");
    expect(routeSource).not.toContain("/public-ai/chat");
    expect(routeSource).not.toContain("/projects/");
    expect(routeSource).not.toContain("deductCredits");
  });
});
