export const TASK_EVENT_EMIT_TIMEOUT_MS = 250;

export type TaskEventEmissionDrop = {
  stage: "persist" | "publish";
  reason: "timeout" | "failure";
  timeoutMs: number;
  errorClass?: string;
};

type TaskEventEmissionOutcome<T> =
  | { kind: "persisted"; value: T }
  | { kind: "failed"; errorClass: string }
  | { kind: "timeout" };

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

function recordDropSafely(
  recordDrop: (drop: TaskEventEmissionDrop) => void,
  drop: TaskEventEmissionDrop,
): void {
  try {
    recordDrop(drop);
  } catch {
    // Diagnostics may never outrank the user's work.
  }
}

/** Best-effort observation: persistence and publication may not block or fail the user's run. */
export async function emitTaskEventBounded<T>(input: {
  persist: () => Promise<T>;
  publish: (value: T) => void;
  recordDrop: (drop: TaskEventEmissionDrop) => void;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const persistence: Promise<TaskEventEmissionOutcome<T>> = Promise.resolve()
    .then(input.persist)
    .then<TaskEventEmissionOutcome<T>, TaskEventEmissionOutcome<T>>(
      (value) => ({ kind: "persisted", value }),
      (error: unknown) => ({ kind: "failed", errorClass: errorClass(error) }),
    );
  const deadline = new Promise<TaskEventEmissionOutcome<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), TASK_EVENT_EMIT_TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
  });

  try {
    const outcome = await Promise.race([persistence, deadline]);
    if (outcome.kind === "timeout") {
      recordDropSafely(input.recordDrop, {
        stage: "persist",
        reason: "timeout",
        timeoutMs: TASK_EVENT_EMIT_TIMEOUT_MS,
      });
      return;
    }
    if (outcome.kind === "failed") {
      recordDropSafely(input.recordDrop, {
        stage: "persist",
        reason: "failure",
        timeoutMs: TASK_EVENT_EMIT_TIMEOUT_MS,
        errorClass: outcome.errorClass,
      });
      return;
    }

    try {
      input.publish(outcome.value);
    } catch (error) {
      recordDropSafely(input.recordDrop, {
        stage: "publish",
        reason: "failure",
        timeoutMs: TASK_EVENT_EMIT_TIMEOUT_MS,
        errorClass: errorClass(error),
      });
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
