import { useEffect, useRef, useState } from "react";
export interface TaskStreamEvent {
  id: number;
  taskId: number;
  eventType: string;
  message: string;
  filePath: string | null;
  createdAt: string | Date;
  /** Structured data for events such as project_files_changed and qa_step. */
  data?: unknown;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type TaskStreamReceipt = {
  event: TaskStreamEvent;
  terminal: boolean;
};

/**
 * A transport open is not proof that a task stream carried task state. Only a
 * valid, task-matching frame is a receipt. This keeps empty/preflight success
 * responses from masquerading as a live task after a reconnect.
 */
export function parseTaskStreamReceipt(
  raw: string,
  expectedTaskId: number,
): TaskStreamReceipt | null {
  try {
    const candidate = JSON.parse(raw) as Partial<TaskStreamEvent>;
    if (
      !Number.isInteger(candidate.id) ||
      (candidate.id ?? -1) < 0 ||
      candidate.taskId !== expectedTaskId ||
      typeof candidate.eventType !== "string" ||
      candidate.eventType.length === 0
    ) {
      return null;
    }
    const event: TaskStreamEvent = {
      id: candidate.id!,
      taskId: candidate.taskId,
      eventType: candidate.eventType,
      message: typeof candidate.message === "string" ? candidate.message : "",
      filePath: typeof candidate.filePath === "string" ? candidate.filePath : null,
      createdAt:
        typeof candidate.createdAt === "string" || candidate.createdAt instanceof Date
          ? candidate.createdAt
          : "",
      data: candidate.data,
    };
    return { event, terminal: TERMINAL_STATUSES.has(event.eventType) };
  } catch {
    return null;
  }
}

export interface TaskEventStreamResult {
  events: TaskStreamEvent[];
  lastEventAt: number | null;
  isConnected: boolean;
}

/**
 * Connects to the SSE stream for a task and accumulates events in real time.
 *
 * The server pushes each event the instant it is created — no polling delay.
 * On connect, the server replays every persisted DB event, so reconnecting does
 * not miss rows that reached storage. Best-effort events dropped before persistence are absent.
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
 * `isConnected` becomes true only after a valid task-matching receipt arrives,
 * not merely when the transport opens. It becomes false once the stream closes,
 * allowing callers to suppress redundant polling only while the channel has
 * proved it is carrying this task.
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

    es.onopen = () => undefined;

    es.onmessage = (raw: MessageEvent<string>) => {
      const receipt = parseTaskStreamReceipt(raw.data, taskId);
      if (!receipt) return;
      setIsConnected(!receipt.terminal);
      const { event } = receipt;
      if (!seenIdsRef.current.has(event.id)) {
        seenIdsRef.current.add(event.id);
        setEvents((prev) => [...prev, event]);
        setLastEventAt(Date.now());
      }
      if (receipt.terminal) es.close();
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
