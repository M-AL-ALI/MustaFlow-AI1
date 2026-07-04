/**
 * Orax Desktop — Phase 2E/2F/2H/2J/2K/2L/2M relay client.
 *
 * Polls the cloud relay for queued actions, executes safe Phase 2E actions
 * (ping_desktop, get_desktop_status, list_local_projects), Phase 2F
 * command actions (run_safe_command — gated by local permission-gate),
 * Phase 2H project-thread actions (run_project_thread — verifies the
 * local path and .orax/project.json binding before confirming context),
 * Phase 2J file-read planning (selectRelevantProjectFiles +
 * readSelectedProjectFiles → deterministic suggestedPlan), Phase 2K
 * patch proposal loop (draft_project_patch — deterministic patch drafter,
 * no shell commands, no file writes), Phase 2L approval-gated apply
 * (apply_project_patch — validates paths, creates checkpoint, writes files
 * only after backend approval; no shell commands, no exec/spawn), and
 * Phase 2M post-apply verification (verify_project_patch — runs allowlisted
 * typecheck/lint/test scripts, no shell:true, no exec, no secrets).
 */

import fs from "node:fs";
import path from "node:path";
import type { OraxApiClient } from "./api-client";
import type { HostManager } from "./host-manager";
import type { LocalProjectsManager } from "./local-projects";
import type { RelayState } from "../shared/types";
import { executeCommand } from "./command-executor";
import { isCommandPermitted } from "./permission-gate";
import { inspectLocalProject } from "./project-inspector";
import type { ProjectInspectionResult } from "./project-inspector";
import {
  selectRelevantProjectFiles,
  type SelectedProjectFile,
} from "./project-file-selector";
import { readSelectedProjectFiles } from "./project-file-reader";
import type { FileReadEntry } from "./project-file-reader";
import { draftProjectPatch } from "./project-patch-drafter";
import { applyProjectPatch, type ApplyFilePatch } from "./project-patch-applier";
import { verifyProjectPatch } from "./project-patch-verifier";
import { draftProjectFix, type FailedCheck } from "./project-fix-drafter";
import { prepareProjectPr } from "./project-git-workflow";

const POLL_INTERVAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

// ── Deterministic plan builder (no AI call) ──────────────────────────────────

function buildSuggestedPlan(
  userMessage: string,
  readFiles: string[],
  inspection: ProjectInspectionResult,
): string {
  const msg = userMessage.toLowerCase();
  const pkgMgr = (inspection.packageManager as string) ?? "your package manager";
  const fileList = readFiles.map((f) => `- ${f}`).join("\n");

  let steps: string[];
  if (/auth|login|sign.?in|session|credential|token/.test(msg)) {
    steps = [
      "Trace how login state is created and passed through the app.",
      "Check the route guard or middleware protecting auth routes.",
      "Identify the failing condition or missing state update.",
      `Run the relevant typecheck or test command via ${pkgMgr}.`,
      "I can prepare the first patch next.",
    ];
  } else if (/api|route|endpoint|request|fetch|http/.test(msg)) {
    steps = [
      "Review the route definitions and handler logic.",
      "Check request validation and error handling paths.",
      "Trace the data flow from client to server.",
      "I can prepare the first patch next.",
    ];
  } else if (/ui|screen|page|component|layout|style|css/.test(msg)) {
    steps = [
      "Review the component structure and state management.",
      "Check for missing props, broken layout, or style conflicts.",
      "Identify the smallest change that fixes the issue.",
      "I can prepare the first patch next.",
    ];
  } else if (/build|typecheck|type error|lint|compile/.test(msg)) {
    steps = [
      "Review the type errors or build configuration.",
      "Check tsconfig, package versions, and import paths.",
      `Run typecheck via ${pkgMgr} to confirm the error scope.`,
      "I can prepare the first patch next.",
    ];
  } else if (/test|spec|vitest|jest|coverage/.test(msg)) {
    steps = [
      "Review the failing test and the code under test.",
      "Check the test setup and mock configuration.",
      "Identify the assertion gap or state mismatch.",
      "I can prepare the first patch next.",
    ];
  } else {
    steps = [
      "Review the relevant files for the requested change.",
      "Trace the data flow and identify the touch points.",
      "Prepare the smallest targeted change.",
      "I can prepare the first patch next.",
    ];
  }

  const stepsText = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `I inspected:\n${fileList}\n\nPlan:\n${stepsText}`;
}

export class RelayClient {
  private state: RelayState = { status: "idle", lastPollAt: null, errorMsg: null };
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = POLL_INTERVAL_MS;
  private seenKeys = new Set<string>();
  private onChange: ((state: RelayState) => void) | null = null;

  constructor(
    private api: OraxApiClient,
    private hostManager: HostManager,
    private localProjects: LocalProjectsManager,
  ) {}

  setOnChange(cb: (state: RelayState) => void): void {
    this.onChange = cb;
  }

  getState(): RelayState {
    return { ...this.state };
  }

  start(): void {
    if (this.state.status === "polling" && this.pollTimer) return;
    this.setState({ status: "polling", errorMsg: null });
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.schedulePoll(0);
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.setState({ status: "idle" });
  }

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
    this.pollTimer?.unref?.();
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    const { hostId } = this.hostManager.getState();
    if (!hostId) {
      this.schedulePoll(POLL_INTERVAL_MS);
      return;
    }

    try {
      const data = await this.api.getPendingActions(hostId);
      this.backoffMs = POLL_INTERVAL_MS;
      this.setState({ status: "polling", lastPollAt: new Date().toISOString(), errorMsg: null });

      for (const action of data.actions ?? []) {
        if (this.seenKeys.has(action.idempotencyKey)) continue;
        this.seenKeys.add(action.idempotencyKey);
        void this.executeAction(action);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Poll failed";
      this.setState({ status: "error", errorMsg });
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    }

    this.schedulePoll(this.backoffMs);
  }

  private async executeAction(action: {
    id: string;
    type: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    status?: string;
  }): Promise<void> {
    try {
      await this.api.postActionEvent(action.id, "acknowledged", {});

      let result: Record<string, unknown> = {};

      if (action.type === "ping_desktop") {
        result = { pong: true, ts: new Date().toISOString() };
      } else if (action.type === "get_desktop_status") {
        const hostState = this.hostManager.getState();
        result = {
          status: hostState.status,
          hostId: hostState.hostId,
          deviceName: hostState.deviceName,
          platform: hostState.platform,
          appVersion: hostState.appVersion,
          permissionMode: hostState.permissionMode,
          uptimeSeconds: Math.round(process.uptime()),
        };
      } else if (action.type === "list_local_projects") {
        result = {
          projects: this.localProjects.list().map((p) => ({
            id: p.id,
            displayName: p.displayName,
            addedAt: p.addedAt,
          })),
        };
      } else if (action.type === "run_safe_command") {
        const payload = action.payload as { command?: string; cwd?: string };
        const command = payload.command ?? "";
        const cwd = payload.cwd;

        // Re-validate locally — the backend already checked, but we add an
        // independent guard so a compromised server cannot run arbitrary commands.
        const gate = isCommandPermitted(command);
        if (!gate.permitted) {
          await this.api.postActionEvent(action.id, "failed", {
            error: `Command blocked by local permission gate: ${gate.reason}`,
          });
          return;
        }

        await this.api.postActionEvent(action.id, "running", {});
        const cmdResult = await executeCommand(command, cwd);

        result = {
          exitCode: cmdResult.exitCode,
          stdout: cmdResult.stdout,
          stderr: cmdResult.stderr,
          durationMs: cmdResult.durationMs,
          timedOut: cmdResult.timedOut,
        };
        // Falls through to the common postActionEvent("completed") call below
      } else if (action.type === "run_project_thread") {
        const payload = action.payload as {
          projectId?: unknown;
          threadId?: unknown;
          executionSourceId?: unknown;
          sourceLocalPath?: unknown;
          userMessage?: unknown;
        };

        const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
        const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
        const executionSourceId =
          typeof payload.executionSourceId === "string" ? payload.executionSourceId : null;
        const sourceLocalPath =
          typeof payload.sourceLocalPath === "string" ? payload.sourceLocalPath : null;

        if (!projectId || !threadId || !executionSourceId || !sourceLocalPath) {
          await this.api.postActionEvent(action.id, "failed", {
            error:
              "run_project_thread: missing required payload fields " +
              "(projectId, threadId, executionSourceId, sourceLocalPath).",
          });
          return;
        }

        // Verify the local path exists on this machine
        if (!fs.existsSync(sourceLocalPath)) {
          await this.api.postActionEvent(action.id, "failed", {
            error: `run_project_thread: sourceLocalPath does not exist: ${sourceLocalPath}`,
          });
          return;
        }

        // Read or create .orax/project.json; reject mismatched projectId
        const oraxDir = path.join(sourceLocalPath, ".orax");
        const projectJsonPath = path.join(oraxDir, "project.json");

        if (fs.existsSync(projectJsonPath)) {
          let stored: { projectId?: string } = {};
          try {
            stored = JSON.parse(fs.readFileSync(projectJsonPath, "utf8")) as {
              projectId?: string;
            };
          } catch {
            // Treat malformed JSON as an unbound project — will be overwritten below
          }
          if (stored.projectId && stored.projectId !== projectId) {
            await this.api.postActionEvent(action.id, "failed", {
              error:
                `run_project_thread: .orax/project.json projectId mismatch ` +
                `(stored="${stored.projectId}", requested="${projectId}"). ` +
                `Remove .orax/project.json manually to rebind this directory.`,
            });
            return;
          }
          // If stored.projectId matches (or is absent), fall through and bind/confirm
        }

        // Signal that we are actively working on this thread
        await this.api.postActionEvent(action.id, "running", {
          projectId,
          threadId,
          executionSourceId,
          sourceLocalPath,
        });

        // Bind the directory to this project (idempotent write)
        if (!fs.existsSync(oraxDir)) {
          fs.mkdirSync(oraxDir, { recursive: true });
        }
        fs.writeFileSync(
          projectJsonPath,
          JSON.stringify({ projectId, executionSourceId, boundAt: new Date().toISOString() }, null, 2),
          "utf8",
        );

        const userMessage =
          typeof payload.userMessage === "string" ? payload.userMessage : "";

        // Inspect the local project safely — no shell, no secrets
        let projectInspection: ProjectInspectionResult | { error: string } | null = null;
        try {
          projectInspection = await inspectLocalProject(sourceLocalPath);
        } catch (inspErr) {
          const msg =
            inspErr instanceof Error ? inspErr.message : "Inspection failed";
          projectInspection = { error: msg };
        }

        // Phase 2J: select and read relevant files (only if inspection succeeded)
        let selectedFiles: SelectedProjectFile[] = [];
        let fileReadSummary: Array<{
          relativePath: string;
          bytesRead: number;
          truncated: boolean;
          reason: string;
        }> = [];
        let suggestedPlan: string | undefined;
        const fileWarnings: string[] = [];

        const inspectionOk =
          projectInspection !== null && !("error" in projectInspection);

        if (inspectionOk && userMessage.trim().length > 0) {
          try {
            const selection = await selectRelevantProjectFiles({
              localPath: sourceLocalPath,
              userMessage,
              inspection: projectInspection as ProjectInspectionResult,
            });
            selectedFiles = selection.files;
            for (const w of selection.warnings) fileWarnings.push(w.message);

            if (selection.files.length > 0) {
              const readResult = await readSelectedProjectFiles({
                localPath: sourceLocalPath,
                files: selection.files,
              });
              fileReadSummary = readResult.files.map((f) => ({
                relativePath: f.relativePath,
                bytesRead: f.bytesRead,
                truncated: f.truncated,
                reason: f.reason,
              }));
              for (const w of readResult.warnings) fileWarnings.push(w.message);
              for (const s of readResult.skipped) {
                fileWarnings.push(`Skipped ${s.relativePath}: ${s.reason}`);
              }

              if (readResult.files.length > 0) {
                suggestedPlan = buildSuggestedPlan(
                  userMessage,
                  readResult.files.map((f) => f.relativePath),
                  projectInspection as ProjectInspectionResult,
                );
              }
            }
          } catch (selErr) {
            fileWarnings.push(
              selErr instanceof Error ? selErr.message : "File selection failed",
            );
          }
        }

        result = {
          projectId,
          threadId,
          executionSourceId,
          localPathVerified: true,
          projectInspection,
          selectedFiles: selectedFiles.map((f) => ({
            relativePath: f.relativePath,
            category: f.category,
            reason: f.reason,
            score: f.score,
          })),
          fileReadSummary,
          ...(suggestedPlan !== undefined ? { suggestedPlan } : {}),
          ...(fileWarnings.length > 0 ? { warnings: fileWarnings } : {}),
        };
        // Falls through to the common postActionEvent("completed") call below
      } else if (action.type === "draft_project_patch") {
        // Phase 2K: deterministic patch proposal — no shell, no file writes
        const payload = action.payload as {
          projectId?: unknown;
          threadId?: unknown;
          executionSourceId?: unknown;
          sourceLocalPath?: unknown;
          userMessage?: unknown;
          selectedFiles?: unknown;
        };

        const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
        const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
        const executionSourceId =
          typeof payload.executionSourceId === "string" ? payload.executionSourceId : null;
        const sourceLocalPath =
          typeof payload.sourceLocalPath === "string" ? payload.sourceLocalPath : null;
        const userMessage =
          typeof payload.userMessage === "string" ? payload.userMessage : "";
        const rawSelectedFiles = Array.isArray(payload.selectedFiles)
          ? (payload.selectedFiles as unknown[])
          : [];

        if (!projectId || !threadId || !executionSourceId || !sourceLocalPath) {
          await this.api.postActionEvent(action.id, "failed", {
            error:
              "draft_project_patch: missing required payload fields " +
              "(projectId, threadId, executionSourceId, sourceLocalPath).",
          });
          return;
        }

        if (!fs.existsSync(sourceLocalPath)) {
          await this.api.postActionEvent(action.id, "failed", {
            error: `draft_project_patch: sourceLocalPath does not exist: ${sourceLocalPath}`,
          });
          return;
        }

        // Verify .orax/project.json binding
        const oraxProjectPath = path.join(sourceLocalPath, ".orax", "project.json");
        if (fs.existsSync(oraxProjectPath)) {
          let stored: { projectId?: string } = {};
          try {
            stored = JSON.parse(fs.readFileSync(oraxProjectPath, "utf8")) as {
              projectId?: string;
            };
          } catch {
            // Treat malformed JSON as unbound — continue
          }
          if (stored.projectId && stored.projectId !== projectId) {
            await this.api.postActionEvent(action.id, "failed", {
              error:
                `draft_project_patch: .orax/project.json projectId mismatch ` +
                `(stored="${stored.projectId}", requested="${projectId}"). ` +
                `Remove .orax/project.json manually to rebind this directory.`,
            });
            return;
          }
        }

        await this.api.postActionEvent(action.id, "running", {
          projectId,
          threadId,
          executionSourceId,
        });

        // Use selectedFiles from payload if available, else re-run selector
        let selectedFiles: SelectedProjectFile[] = rawSelectedFiles.filter(
          (f): f is SelectedProjectFile =>
            typeof (f as Record<string, unknown>).relativePath === "string" &&
            typeof (f as Record<string, unknown>).category === "string",
        );

        const patchWarnings: string[] = [];

        if (selectedFiles.length === 0 && userMessage.trim().length > 0) {
          try {
            let inspection: ProjectInspectionResult | { error: string } | null = null;
            try {
              inspection = await inspectLocalProject(sourceLocalPath);
            } catch {
              inspection = null;
            }
            if (inspection && !("error" in inspection)) {
              const selection = await selectRelevantProjectFiles({
                localPath: sourceLocalPath,
                userMessage,
                inspection: inspection as ProjectInspectionResult,
              });
              selectedFiles = selection.files;
              for (const w of selection.warnings) patchWarnings.push(w.message);
            }
          } catch (selErr) {
            patchWarnings.push(
              selErr instanceof Error ? selErr.message : "File selection failed",
            );
          }
        }

        // Read file contents for the patch drafter
        let fileReadEntries: FileReadEntry[] = [];
        if (selectedFiles.length > 0) {
          try {
            const readResult = await readSelectedProjectFiles({
              localPath: sourceLocalPath,
              files: selectedFiles,
            });
            fileReadEntries = readResult.files;
            for (const w of readResult.warnings) patchWarnings.push(w.message);
          } catch (readErr) {
            patchWarnings.push(
              readErr instanceof Error ? readErr.message : "File read for patch failed",
            );
          }
        }

        const draftResult = await draftProjectPatch({
          localPath: sourceLocalPath,
          userMessage,
          selectedFiles,
          fileReadEntries,
          suggestedPlan: undefined,
        });

        result = {
          projectId,
          threadId,
          executionSourceId,
          userMessage,
          draftPatch: draftResult.draftPatch,
          filePreviews: draftResult.filePreviews, // Phase 2L: capped content for backend AI
          warnings: [...patchWarnings, ...draftResult.warnings],
        };
        // Falls through to the common postActionEvent("completed") call below
      } else if (action.type === "apply_project_patch") {
        // Phase 2L: approval-gated apply — validates paths, creates checkpoint, writes files
        const payload = action.payload as {
          projectId?: unknown;
          threadId?: unknown;
          executionSourceId?: unknown;
          sourceLocalPath?: unknown;
          patches?: unknown;
        };

        const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
        const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
        const executionSourceId =
          typeof payload.executionSourceId === "string" ? payload.executionSourceId : null;
        const sourceLocalPath =
          typeof payload.sourceLocalPath === "string" ? payload.sourceLocalPath : null;
        const rawPatches = Array.isArray(payload.patches) ? (payload.patches as unknown[]) : [];

        if (!projectId || !threadId || !executionSourceId || !sourceLocalPath) {
          await this.api.postActionEvent(action.id, "failed", {
            error:
              "apply_project_patch: missing required payload fields " +
              "(projectId, threadId, executionSourceId, sourceLocalPath).",
          });
          return;
        }

        if (!fs.existsSync(sourceLocalPath)) {
          await this.api.postActionEvent(action.id, "failed", {
            error: "apply_project_patch: sourceLocalPath does not exist",
          });
          return;
        }

        // Verify .orax/project.json binding
        const oraxProjPath = path.join(sourceLocalPath, ".orax", "project.json");
        if (fs.existsSync(oraxProjPath)) {
          let stored: { projectId?: string } = {};
          try {
            stored = JSON.parse(fs.readFileSync(oraxProjPath, "utf8")) as { projectId?: string };
          } catch {
            // Treat malformed JSON as unbound — continue
          }
          if (stored.projectId && stored.projectId !== projectId) {
            await this.api.postActionEvent(action.id, "failed", {
              error:
                `apply_project_patch: .orax/project.json projectId mismatch ` +
                `(stored="${stored.projectId}", requested="${projectId}"). ` +
                `Remove .orax/project.json to rebind this directory.`,
            });
            return;
          }
        }

        // Validate and coerce patches
        const patches: ApplyFilePatch[] = rawPatches.filter(
          (p): p is ApplyFilePatch =>
            typeof (p as Record<string, unknown>).relativePath === "string" &&
            typeof (p as Record<string, unknown>).newContent === "string" &&
            ((p as Record<string, unknown>).operation === "update" ||
              (p as Record<string, unknown>).operation === "create"),
        );

        if (patches.length === 0) {
          await this.api.postActionEvent(action.id, "failed", {
            error: "apply_project_patch: no valid patches in payload.",
          });
          return;
        }

        await this.api.postActionEvent(action.id, "running", {
          projectId,
          threadId,
          executionSourceId,
        });

        const applyResult = await applyProjectPatch({
          localPath: sourceLocalPath,
          threadId,
          patches,
        });

        result = {
          projectId,
          threadId,
          executionSourceId,
          changedFiles: applyResult.changedFiles,
          checkpointPath: applyResult.checkpointPath,
          warnings: applyResult.warnings,
          durationMs: applyResult.durationMs,
        };
        // Falls through to the common postActionEvent("completed") call below
      } else if (action.type === "verify_project_patch") {
        // Phase 2M: post-apply verification — no shell, no exec, no secrets
        const payload = action.payload as {
          projectId?: unknown;
          threadId?: unknown;
          executionSourceId?: unknown;
          sourceLocalPath?: unknown;
        };

        const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
        const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
        const executionSourceId =
          typeof payload.executionSourceId === "string" ? payload.executionSourceId : null;
        const sourceLocalPath =
          typeof payload.sourceLocalPath === "string" ? payload.sourceLocalPath : null;

        if (!projectId || !threadId || !sourceLocalPath) {
          await this.api.postActionEvent(action.id, "failed", {
            error:
              "verify_project_patch: missing required payload fields " +
              "(projectId, threadId, sourceLocalPath).",
          });
          return;
        }

        if (!fs.existsSync(sourceLocalPath)) {
          await this.api.postActionEvent(action.id, "failed", {
            error: "verify_project_patch: sourceLocalPath does not exist",
          });
          return;
        }

        await this.api.postActionEvent(action.id, "running", {
          projectId,
          threadId,
          executionSourceId,
        });

        const verifyResult = await verifyProjectPatch({ localPath: sourceLocalPath });

        result = {
          projectId,
          threadId,
          executionSourceId,
          checks: verifyResult.checks,
          totalDurationMs: verifyResult.totalDurationMs,
          allPassed: verifyResult.allPassed,
        };
        // Falls through to the common postActionEvent("completed") call below
      } else if (action.type === "draft_project_fix") {
        // Phase 2N: auto-fix from verification failure
        const payload = action.payload as {
          projectId?: unknown;
          threadId?: unknown;
          executionSourceId?: unknown;
          sourceLocalPath?: unknown;
          failedChecks?: unknown;
          changedFiles?: unknown;
          originalUserMessage?: unknown;
          previousPatchSummary?: unknown;
        };

        const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
        const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
        const executionSourceId =
          typeof payload.executionSourceId === "string" ? payload.executionSourceId : null;
        const sourceLocalPath =
          typeof payload.sourceLocalPath === "string" ? payload.sourceLocalPath : null;

        if (!projectId || !threadId || !sourceLocalPath) {
          await this.api.postActionEvent(action.id, "failed", {
            error:
              "draft_project_fix: missing required payload fields " +
              "(projectId, threadId, sourceLocalPath).",
          });
          return;
        }

        if (!fs.existsSync(sourceLocalPath)) {
          await this.api.postActionEvent(action.id, "failed", {
            error: "draft_project_fix: sourceLocalPath does not exist",
          });
          return;
        }

        const failedChecks = Array.isArray(payload.failedChecks)
          ? (payload.failedChecks as FailedCheck[])
          : [];
        const changedFiles = Array.isArray(payload.changedFiles)
          ? (payload.changedFiles as Array<{ relativePath: string; operation: string }>)
          : [];
        const originalUserMessage =
          typeof payload.originalUserMessage === "string" ? payload.originalUserMessage : "";
        const previousPatchSummary =
          typeof payload.previousPatchSummary === "string" ? payload.previousPatchSummary : "";

        await this.api.postActionEvent(action.id, "running", {
          projectId,
          threadId,
          executionSourceId,
        });

        // Re-read changedFiles to get current on-disk content as file entries
        const selectedFiles: SelectedProjectFile[] = changedFiles.map((f) => ({
          relativePath: f.relativePath,
          reason: "previously patched file",
          score: 1,
          category: "unknown" as const,
        }));
        const readResult = await readSelectedProjectFiles({
          localPath: sourceLocalPath,
          files: selectedFiles,
        });
        const fileReadEntries = readResult.files;

        const fixResult = await draftProjectFix({
          localPath: sourceLocalPath,
          failedChecks,
          changedFiles,
          fileReadEntries,
          previousPatchSummary,
          originalUserMessage,
        });

        result = {
          projectId,
          threadId,
          executionSourceId,
          draftPatch: fixResult.draftPatch,
          filePreviews: fixResult.filePreviews,
          failedChecks: failedChecks.slice(0, 3),
          originalUserMessage,
          warnings: fixResult.warnings,
        };
        // Falls through to the common postActionEvent("completed") call below
      } else if (action.type === "prepare_project_pr") {
        // Phase 3B: Git branch, commit, and push after verified patch.
        // Uses a fixed arg array via project-git-workflow.ts — no shell execution, no force-push,
        // no hard-resets, no working-tree wipes.
        const payload = action.payload as {
          projectId?: unknown;
          threadId?: unknown;
          executionSourceId?: unknown;
          sourceLocalPath?: unknown;
          changedFiles?: unknown;
          commitMessage?: unknown;
          projectSlug?: unknown;
          githubToken?: unknown;
        };

        const projectId =
          typeof payload.projectId === "string" ? payload.projectId : null;
        const threadId =
          typeof payload.threadId === "string" ? payload.threadId : null;
        const executionSourceId =
          typeof payload.executionSourceId === "string"
            ? payload.executionSourceId
            : null;
        const sourceLocalPath =
          typeof payload.sourceLocalPath === "string" ? payload.sourceLocalPath : null;

        if (!projectId || !threadId || !sourceLocalPath) {
          await this.api.postActionEvent(action.id, "failed", {
            error:
              "prepare_project_pr: missing required payload fields " +
              "(projectId, threadId, sourceLocalPath).",
          });
          return;
        }

        if (!fs.existsSync(sourceLocalPath)) {
          await this.api.postActionEvent(action.id, "failed", {
            error: "prepare_project_pr: sourceLocalPath does not exist",
          });
          return;
        }

        const changedFiles = Array.isArray(payload.changedFiles)
          ? (payload.changedFiles as unknown[]).filter(
              (f): f is string => typeof f === "string",
            )
          : [];
        const commitMessage =
          typeof payload.commitMessage === "string"
            ? payload.commitMessage
            : "Orax approved patch";
        const projectSlug =
          typeof payload.projectSlug === "string" ? payload.projectSlug : "patch";
        const githubToken =
          typeof payload.githubToken === "string" ? payload.githubToken : undefined;

        await this.api.postActionEvent(action.id, "running", {
          projectId,
          threadId,
          executionSourceId,
        });

        const prResult = await prepareProjectPr({
          projectDir: sourceLocalPath,
          threadId,
          projectSlug,
          changedFiles,
          commitMessage,
          githubToken,
        });

        result = {
          projectId,
          threadId,
          executionSourceId,
          branchName: prResult.branchName,
          commitSha: prResult.commitSha,
          changedFiles: prResult.changedFiles,
          prUrl: prResult.prUrl,
          warnings: prResult.warnings,
          durationMs: prResult.durationMs,
        };
        // Falls through to the common postActionEvent("completed") call below
      } else {
        await this.api.postActionEvent(action.id, "failed", {
          error: `Unsupported action type: ${action.type}`,
        });
        return;
      }

      await this.api.postActionEvent(action.id, "completed", result);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Action execution failed";
      try {
        await this.api.postActionEvent(action.id, "failed", { error });
      } catch {
        /* best-effort */
      }
    }
  }

  private setState(patch: Partial<RelayState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange?.({ ...this.state });
  }
}
