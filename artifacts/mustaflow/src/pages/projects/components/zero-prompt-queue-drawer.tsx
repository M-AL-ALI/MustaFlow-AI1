import { authFetch } from "@/lib/api-fetch";
import {
  ZERO_PROMPT_QUEUE_MAX_ITEMS,
  ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS,
  ZERO_PROMPT_QUEUE_PHASE_RULES,
  ZERO_PROMPT_QUEUE_UNKNOWN_PHASE,
  type ZeroPromptQueueObservedPhase,
  type ZeroPromptQueueRunPhase,
} from "@workspace/ora-contracts";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const QUEUE_FALLBACK_ERROR = "The queued prompts could not be updated. Please try again.";
const TECHNICAL_ERROR_PATTERN = /postgres|constraint|sqlstate|stack|23505|internal server/i;

const USER_VISIBLE_QUEUE_ERROR_CODES = new Set([
  "queue_edit_empty",
  "queue_active_turn_not_queue_item",
  "queue_full",
  "queue_item_text_too_long",
  "queue_item_not_found",
  "queue_item_terminal",
  "queue_position_invalid",
  "queue_persistence_unavailable",
  "queue_persistence_contract_invalid",
  "queue_persistence_write_bound_exceeded",
  "queue_provenance_missing",
  "queue_request_invalid",
  "queue_unauthenticated",
  "queue_request_failed",
]);

export type PromptQueueItemView = {
  id: string;
  position: number;
  currentText: string;
};

export const ZERO_PROMPT_QUEUE_HISTORY_LIMIT = 10;

export type PromptQueueHistoryItemView = {
  id: string;
  currentText: string;
  outcome: "used" | "removed";
  occurredAt: string;
};

export type PromptQueueView = {
  items: readonly PromptQueueItemView[];
  history: readonly PromptQueueHistoryItemView[];
  truncated: boolean;
  historyTruncated: boolean;
};

const PHASE_WAIT_COPY: Record<ZeroPromptQueueRunPhase, string> = {
  between_steps: "Zero is between steps. Your prompts are saved for the next safe pause.",
  createChatCompletion:
    "Zero is preparing the next response. Your prompts are saved for the next safe pause.",
  parallel_tool_batch:
    "Zero is working through a group of actions. Your prompts are saved for the next safe pause.",
  serial_tool_call: "Zero is working on an action. Your prompts are saved for the next safe pause.",
  executeSingleFileWrite:
    "Zero is saving one file. Your prompts are saved for the next safe pause.",
  executeBatchFileWrite:
    "Zero is saving a group of files. Your prompts are saved for the next safe pause.",
  finalize_check: "Zero is reviewing the result. Your prompts are saved for the next safe pause.",
  auto_check: "Zero is checking the work. Your prompts are saved for the next safe pause.",
  post_loop_check:
    "Zero is completing the final checks. Your prompts are saved and will wait for the next run.",
  e2e_smoke:
    "Zero is testing the finished app. Your prompts are saved and will wait for the next run.",
  e2e_auto_fix:
    "Zero is repairing a test result. Your prompts are saved and will wait for the next run.",
  project_files_commit:
    "Zero is saving the project version. Your prompts are saved and will wait for the next run.",
  runPostWriteMigrationSync:
    "Zero is updating the project's database setup. Your prompts are saved and will wait for the next run.",
  production_publish:
    "Zero is publishing the app. Your prompts are saved and will wait for the next run.",
};

export function promptQueueLandingMessage(
  activeTaskId: number | null,
  phase: ZeroPromptQueueObservedPhase | null,
): string {
  if (activeTaskId === null) {
    return "Zero is not running right now. Queued prompts will wait for the next run.";
  }
  if (phase === null) {
    return "Zero is working, but its current step is not available yet. Your prompts are saved for the next safe pause.";
  }
  if (phase === ZERO_PROMPT_QUEUE_UNKNOWN_PHASE) {
    return "Zero is working in a step this screen does not recognize yet. Your prompts are saved for the next safe pause.";
  }
  const rule = ZERO_PROMPT_QUEUE_PHASE_RULES.find((candidate) => candidate.phase === phase);
  if (!rule) {
    return "Zero is working in a step this screen does not recognize yet. Your prompts are saved for the next safe pause.";
  }
  return PHASE_WAIT_COPY[phase];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePromptQueuePayload(value: unknown): PromptQueueView {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { items: [], history: [], truncated: false, historyTruncated: false };
  }
  const queuedItems = value.items
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        item.state === "queued" &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        Number.isSafeInteger(item.position) &&
        Number(item.position) > 0 &&
        typeof item.currentText === "string",
    )
    .map((item) => ({
      id: item.id as string,
      position: Number(item.position),
      currentText: item.currentText as string,
    }))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));

  const historyItems = value.items
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        (item.state === "promoted" || item.state === "deleted") &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.currentText === "string" &&
        isRecord(item.terminalEvidence) &&
        typeof item.terminalEvidence.occurredAt === "string" &&
        !Number.isNaN(Date.parse(item.terminalEvidence.occurredAt)) &&
        ((item.state === "promoted" && item.terminalEvidence.kind === "promoted") ||
          (item.state === "deleted" && item.terminalEvidence.kind === "deleted")),
    )
    .map((item) => ({
      id: item.id as string,
      currentText: item.currentText as string,
      outcome: item.state === "promoted" ? ("used" as const) : ("removed" as const),
      occurredAt: (item.terminalEvidence as Record<string, unknown>).occurredAt as string,
    }))
    .sort(
      (left, right) =>
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
        left.id.localeCompare(right.id),
    );

  return {
    items: queuedItems.slice(0, ZERO_PROMPT_QUEUE_MAX_ITEMS),
    history: historyItems.slice(0, ZERO_PROMPT_QUEUE_HISTORY_LIMIT),
    truncated: queuedItems.length > ZERO_PROMPT_QUEUE_MAX_ITEMS,
    historyTruncated: historyItems.length > ZERO_PROMPT_QUEUE_HISTORY_LIMIT,
  };
}

function promptHistoryTime(occurredAt: string): string {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(occurredAt))} UTC`;
}

export function selectPromptQueueError(value: unknown): string {
  if (!isRecord(value)) return QUEUE_FALLBACK_ERROR;
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.error === "string" ? value.error : "";
  if (
    !USER_VISIBLE_QUEUE_ERROR_CODES.has(code) ||
    message.length === 0 ||
    message.length > 240 ||
    TECHNICAL_ERROR_PATTERN.test(message)
  ) {
    return QUEUE_FALLBACK_ERROR;
  }
  return message;
}

class PromptQueueRequestError extends Error {}

async function queueRequest(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await authFetch(path, init);
  } catch {
    throw new PromptQueueRequestError(QUEUE_FALLBACK_ERROR);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A malformed response is never rendered verbatim.
  }
  if (!response.ok) throw new PromptQueueRequestError(selectPromptQueueError(body));
  return body;
}

interface ZeroPromptQueueDrawerProps {
  projectId: number;
  activeTaskId: number | null;
  phase: ZeroPromptQueueObservedPhase | null;
  onClose: () => void;
}

export function ZeroPromptQueueDrawer({
  projectId,
  activeTaskId,
  phase,
  onClose,
}: ZeroPromptQueueDrawerProps) {
  const [queue, setQueue] = useState<PromptQueueView>({
    items: [],
    history: [],
    truncated: false,
    historyTruncated: false,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newText, setNewText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const previousPhaseRef = useRef<ZeroPromptQueueObservedPhase | null>(phase);

  const loadQueue = useCallback(async () => {
    try {
      const body = await queueRequest(`/api/projects/${projectId}/prompt-queue?limit=50`);
      setQueue(normalizePromptQueuePayload(body));
      setError(null);
    } catch (requestError) {
      setError(
        requestError instanceof PromptQueueRequestError
          ? requestError.message
          : QUEUE_FALLBACK_ERROR,
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (activeTaskId !== null && phase === "between_steps" && previousPhase !== "between_steps") {
      void loadQueue();
    }
  }, [activeTaskId, loadQueue, phase]);

  const mutateQueue = useCallback(
    async (path: string, init: RequestInit) => {
      setBusy(true);
      setError(null);
      try {
        await queueRequest(path, init);
        await loadQueue();
        return true;
      } catch (requestError) {
        setError(
          requestError instanceof PromptQueueRequestError
            ? requestError.message
            : QUEUE_FALLBACK_ERROR,
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadQueue],
  );

  const items = useMemo(() => queue.items, [queue.items]);
  const landingMessage = promptQueueLandingMessage(activeTaskId, phase);

  const addPrompt = async () => {
    const accepted = await mutateQueue(`/api/projects/${projectId}/prompt-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: items.length + 1, text: newText, references: [] }),
    });
    if (accepted) setNewText("");
  };

  const reorder = (item: PromptQueueItemView, position: number) =>
    mutateQueue(`/api/projects/${projectId}/prompt-queue/${encodeURIComponent(item.id)}/position`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position }),
    });

  const saveEdit = async (item: PromptQueueItemView) => {
    const accepted = await mutateQueue(
      `/api/projects/${projectId}/prompt-queue/${encodeURIComponent(item.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: editText }),
      },
    );
    if (accepted) setEditingId(null);
  };

  return (
    <aside
      role="dialog"
      aria-label="Queued prompts"
      className="absolute inset-0 z-40 flex flex-col bg-zinc-950 border-l border-border"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Queued prompts</h2>
          <p className="text-[10px] text-muted-foreground">{items.length} of 50 prompts queued</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close queued prompts"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="px-4 py-3 border-b border-border bg-muted/20">
        <p
          data-testid="queue-landing-message"
          className="text-xs text-muted-foreground leading-relaxed"
        >
          {landingMessage}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading queued prompts…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No prompts are queued. Add one to line up Zero's next task.
          </p>
        ) : (
          <ol className="space-y-2" aria-label="Prompt order">
            {items.map((item, index) => (
              <li key={item.id} className="rounded-lg border border-border bg-muted/20 p-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-1 text-[10px] font-semibold text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {editingId === item.id ? (
                      <textarea
                        aria-label={`Edit queued prompt ${index + 1}`}
                        value={editText}
                        onChange={(event) => setEditText(event.target.value)}
                        maxLength={ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS}
                        className="w-full min-h-16 resize-y rounded-md border border-border bg-zinc-950 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
                      />
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                        {item.currentText}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-end gap-1">
                  {editingId === item.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                        className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveEdit(item)}
                        disabled={busy}
                        className="rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground disabled:opacity-50"
                      >
                        Save
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={`Move prompt ${index + 1} up`}
                        onClick={() => void reorder(item, index)}
                        disabled={busy || index === 0}
                        className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move prompt ${index + 1} down`}
                        onClick={() => void reorder(item, index + 2)}
                        disabled={busy || index === items.length - 1}
                        className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit prompt ${index + 1}`}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditText(item.currentText);
                        }}
                        disabled={busy}
                        className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete prompt ${index + 1}`}
                        onClick={() =>
                          void mutateQueue(
                            `/api/projects/${projectId}/prompt-queue/${encodeURIComponent(item.id)}`,
                            { method: "DELETE" },
                          )
                        }
                        disabled={busy}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {queue.truncated && (
          <p role="status" className="text-[10px] text-amber-300">
            Only the first 50 queued prompts are shown.
          </p>
        )}

        {queue.history.length > 0 && (
          <section aria-labelledby="zero-prompt-history-heading" className="pt-3">
            <h3 id="zero-prompt-history-heading" className="text-xs font-semibold text-foreground">
              Prompt history
            </h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              What happened to prompts that left the queue.
            </p>
            <ul aria-label="Prompt history" className="mt-2 space-y-2">
              {queue.history.map((item) => (
                <li key={item.id} className="rounded-lg border border-border bg-muted/10 p-2.5">
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                    {item.currentText}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {item.outcome === "used" ? "Used by Zero" : "Removed by you"}
                    {" · "}
                    <time dateTime={item.occurredAt}>{promptHistoryTime(item.occurredAt)}</time>
                  </p>
                </li>
              ))}
            </ul>
            {queue.historyTruncated && (
              <p role="status" className="mt-2 text-[10px] text-amber-300">
                Only the first 10 prompt history entries are shown.
              </p>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="border-t border-border p-3">
        <label
          htmlFor="zero-queue-new-prompt"
          className="text-[10px] font-medium text-muted-foreground"
        >
          Add a prompt
        </label>
        <textarea
          id="zero-queue-new-prompt"
          aria-label="New queued prompt"
          value={newText}
          onChange={(event) => setNewText(event.target.value)}
          maxLength={ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS}
          placeholder="What should Zero do next?"
          className="mt-1 w-full min-h-16 resize-y rounded-md border border-border bg-muted/20 px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary"
        />
        <button
          type="button"
          onClick={() => void addPrompt()}
          disabled={
            busy || newText.trim().length === 0 || items.length >= ZERO_PROMPT_QUEUE_MAX_ITEMS
          }
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add to queue
        </button>
      </div>
    </aside>
  );
}
