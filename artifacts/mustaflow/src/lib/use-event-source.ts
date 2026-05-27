import { useEffect, useRef } from "react";

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

export interface UseEventSourceOptions {
  /** Called for every incoming `message` event. */
  onMessage: (evt: MessageEvent) => void;
  /** Called when the connection opens (or re-opens after a retry). */
  onOpen?: () => void;
}

/**
 * Opens a persistent SSE connection to `url` and retries with exponential
 * back-off whenever the connection drops.
 *
 * Back-off schedule: 1 s → 2 s → 4 s → … → 30 s (cap).
 * The delay resets to 1 s after every successful message.
 *
 * Pass `null` as the URL to disable the connection (useful when a required
 * value like `projectId` is not yet available).
 *
 * The connection is closed and all timers are cleared on unmount.
 */
export function useEventSource(
  url: string | null,
  { onMessage, onOpen }: UseEventSourceOptions,
): void {
  // Keep stable refs so callers don't need to memoize callbacks
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!url) return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let currentDelay = INITIAL_DELAY_MS;
    let destroyed = false;

    function connect() {
      if (destroyed) return;

      es = new EventSource(url as string);

      es.onopen = () => {
        onOpenRef.current?.();
      };

      es.onmessage = (evt: MessageEvent) => {
        // Successful message → reset back-off
        currentDelay = INITIAL_DELAY_MS;
        onMessageRef.current(evt);
      };

      es.onerror = () => {
        // Close the broken connection so the browser stops its own retry
        es?.close();
        es = null;

        if (destroyed) return;

        // Guard: onerror can fire multiple times on a single broken connection,
        // so only schedule a retry when one isn't already pending.
        if (retryTimer !== null) return;

        // Schedule a reconnect with the current back-off delay
        retryTimer = setTimeout(() => {
          retryTimer = null;
          currentDelay = Math.min(currentDelay * BACKOFF_FACTOR, MAX_DELAY_MS);
          connect();
        }, currentDelay);
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      es?.close();
    };
  }, [url]);
}
