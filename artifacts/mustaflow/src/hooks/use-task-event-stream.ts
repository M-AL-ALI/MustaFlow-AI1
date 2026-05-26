import { useEffect, useRef, useState } from "react";

export interface TaskStreamEvent {
  id: number;
  taskId: number;
  eventType: string;
  message: string;
  filePath: string | null;
  createdAt: string | Date;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface TaskEventStreamResult {
  events: TaskStreamEvent[];
  lastEventAt: number | null;
  isConnected: boolean;
}

/**
 * Connects to the SSE stream for a task and accumulates events in real time.
 *
 * The server pushes each event the instant it is created — no polling delay.
 * On connect, the server replays the full DB history so the hook is safe to
 * mount at any point during a build (no missed events).
 *
 * Deduplication is handled client-side via a seenIds Set so reconnects
 * (EventSource auto-reconnects on network drops) don't produce duplicates.
 *
 * The connection closes automatically once a terminal event arrives
 * (completed / failed / cancelled). Cleanup also fires on unmount.
 *
 * `lastEventAt` is a `Date.now()` timestamp updated on every incoming event,
 * used by consumers to detect idle gaps between tool calls.
 *
 * `isConnected` becomes true once the SSE connection is open and false once
 * it closes, allowing callers to suppress redundant polling while the channel
 * is live.
 */
export function useTaskEventStream(projectId: number, taskId: number): TaskEventStreamResult {
  const [events, setEvents] = useState<TaskStreamEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const seenIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    seenIdsRef.current = new Set();
    setEvents([]);
    setLastEventAt(null);
    setIsConnected(false);

    const es = new EventSource(`/api/projects/${projectId}/tasks/${taskId}/events/stream`);

    es.onopen = () => {
      setIsConnected(true);
    };

    es.onmessage = (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as TaskStreamEvent;
        if (seenIdsRef.current.has(event.id)) return;
        seenIdsRef.current.add(event.id);
        setEvents((prev) => [...prev, event]);
        setLastEventAt(Date.now());
        if (TERMINAL_STATUSES.has(event.eventType)) {
          setIsConnected(false);
          es.close();
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      setIsConnected(false);
      es.close();
    };
  }, [projectId, taskId]);

  return { events, lastEventAt, isConnected };
}
