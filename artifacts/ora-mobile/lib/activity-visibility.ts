/**
 * Minimum-visibility controller for the Ora activity-trace row.
 *
 * When an SSE "activity" event and the first "token" event arrive in the same
 * XHR readyState=3 callback burst, React batches the resulting state updates
 * and the activity label may never paint. This controller defers the "clear"
 * call until the label has been visible for at least ACTIVITY_MIN_SHOW_MS,
 * preventing the race without changing the pushActivity signature or the
 * OraThinkingRow contract.
 *
 * All timing primitives are injected so tests can drive the clock without
 * relying on real setTimeout.
 */

export const ACTIVITY_MIN_SHOW_MS = 200;

export interface ActivityVisibilityController {
  /**
   * Record that a new activity step just became visible. Cancels any pending
   * deferred clear from a previous scheduleClear call.
   */
  notifyVisible(): void;
  /**
   * Request to clear the activity label. If the minimum-show window has not
   * yet elapsed, defers the call to doClear until it has. A subsequent
   * notifyVisible() cancels the deferred call automatically.
   */
  scheduleClear(doClear: () => void): void;
  /** Cancel any in-flight deferred clear. Call on component unmount. */
  dispose(): void;
}

export function createActivityVisibilityController(opts?: {
  minShowMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}): ActivityVisibilityController {
  const minShowMs = opts?.minShowMs ?? ACTIVITY_MIN_SHOW_MS;
  const now = opts?.now ?? (() => Date.now());
  const schedule =
    opts?.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    opts?.cancel ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));

  let minShowUntil = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelPending(): void {
    if (pendingTimer !== null) {
      cancel(pendingTimer);
      pendingTimer = null;
    }
  }

  return {
    notifyVisible() {
      cancelPending();
      minShowUntil = now() + minShowMs;
    },
    scheduleClear(doClear: () => void) {
      cancelPending();
      const remaining = minShowUntil - now();
      if (remaining <= 0) {
        doClear();
        return;
      }
      pendingTimer = schedule(() => {
        pendingTimer = null;
        doClear();
      }, remaining);
    },
    dispose() {
      cancelPending();
    },
  };
}
