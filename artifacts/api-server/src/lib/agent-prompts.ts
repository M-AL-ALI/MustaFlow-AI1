/**
 * In-memory pending-prompt registry for the agentic builder loop's
 * human-in-the-loop tools (Task #532).
 *
 * - `user_query` / `request_secret` create a prompt and await a user response
 *   delivered via `POST /api/projects/:id/tasks/:taskId/prompts/:promptId/respond`.
 * - Each prompt times out after `timeoutMs` (default 5 min) and is auto-rejected
 *   when the loop's AbortSignal fires (cancel / wall-clock cap).
 * - Resolution payload shape is opaque to this module — the executing tool
 *   decides what shape its observation takes.
 *
 * State is process-local. A multi-instance deployment would need a shared
 * channel (e.g. Redis Pub/Sub), but the agent loop also runs in-process so
 * this is the right scope for the current architecture.
 */

import { randomUUID } from "crypto";

export type AgentPromptKind = "user_query" | "request_secret" | "suggest_deploy";

export interface AgentPromptRecord {
  promptId: string;
  taskId: number;
  projectId: number;
  kind: AgentPromptKind;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

interface PendingEntry extends AgentPromptRecord {
  resolve: (value: Record<string, unknown>) => void;
  timeout: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

const pending = new Map<string, PendingEntry>();

export const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000;
const MAX_PROMPT_TIMEOUT_MS = 15 * 60_000;
const MIN_PROMPT_TIMEOUT_MS = 5_000;

export interface CreatePromptOpts {
  taskId: number;
  projectId: number;
  kind: AgentPromptKind;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
}

export function createPrompt(opts: CreatePromptOpts): {
  promptId: string;
  promise: Promise<Record<string, unknown>>;
} {
  const promptId = randomUUID();
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS, MIN_PROMPT_TIMEOUT_MS),
    MAX_PROMPT_TIMEOUT_MS,
  );
  const createdAt = Date.now();
  const expiresAt = createdAt + timeoutMs;

  const promise = new Promise<Record<string, unknown>>((resolve) => {
    const cleanup = () => {
      const e = pending.get(promptId);
      if (!e) return;
      clearTimeout(e.timeout);
      if (e.signal && e.abortHandler) {
        try {
          e.signal.removeEventListener("abort", e.abortHandler);
        } catch {
          /* ignore */
        }
      }
      pending.delete(promptId);
    };

    if (opts.signal.aborted) {
      resolve({ canceled: true, reason: "aborted" });
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ canceled: true, reason: "timeout", timeoutMs });
    }, timeoutMs);

    const entry: PendingEntry = {
      promptId,
      taskId: opts.taskId,
      projectId: opts.projectId,
      kind: opts.kind,
      payload: opts.payload,
      createdAt,
      expiresAt,
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      timeout,
      signal: opts.signal,
    };
    const abortHandler = () => {
      cleanup();
      resolve({ canceled: true, reason: "aborted" });
    };
    entry.abortHandler = abortHandler;
    opts.signal.addEventListener("abort", abortHandler, { once: true });
    pending.set(promptId, entry);
  });

  return { promptId, promise };
}

export function respondToPrompt(
  promptId: string,
  taskId: number,
  projectId: number,
  response: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  const entry = pending.get(promptId);
  if (!entry) return { ok: false, reason: "not_found" };
  if (entry.taskId !== taskId || entry.projectId !== projectId) {
    return { ok: false, reason: "mismatch" };
  }
  entry.resolve(response);
  return { ok: true };
}

export function listPendingPromptsForTask(taskId: number): AgentPromptRecord[] {
  const out: AgentPromptRecord[] = [];
  for (const entry of pending.values()) {
    if (entry.taskId === taskId) {
      out.push({
        promptId: entry.promptId,
        taskId: entry.taskId,
        projectId: entry.projectId,
        kind: entry.kind,
        payload: entry.payload,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      });
    }
  }
  return out;
}
