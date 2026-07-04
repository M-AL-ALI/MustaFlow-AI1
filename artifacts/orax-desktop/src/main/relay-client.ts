/**
 * Orax Desktop — Phase 2E/2F/2H relay client.
 *
 * Polls the cloud relay for queued actions, executes safe Phase 2E actions
 * (ping_desktop, get_desktop_status, list_local_projects), Phase 2F
 * command actions (run_safe_command — gated by local permission-gate),
 * and Phase 2H project-thread actions (run_project_thread — verifies the
 * local path and .orax/project.json binding before confirming context).
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

const POLL_INTERVAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

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

        // Inspect the local project safely — no shell, no secrets
        let projectInspection: Record<string, unknown> | null = null;
        try {
          const inspection = await inspectLocalProject(sourceLocalPath);
          projectInspection = inspection as unknown as Record<string, unknown>;
        } catch (inspErr) {
          const msg =
            inspErr instanceof Error ? inspErr.message : "Inspection failed";
          projectInspection = { error: msg };
        }

        result = {
          projectId,
          threadId,
          executionSourceId,
          localPathVerified: true,
          projectInspection,
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
