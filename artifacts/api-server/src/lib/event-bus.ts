import { EventEmitter } from "events";

export interface TaskEventPayload {
  id: number;
  taskId: number;
  eventType: string;
  message: string;
  filePath: string | null;
  createdAt: Date | string;
}

const bus = new EventEmitter();
bus.setMaxListeners(200);

export function publishTaskEvent(payload: TaskEventPayload): void {
  bus.emit(`task:${payload.taskId}`, payload);
}

export function subscribeTaskEvents(
  taskId: number,
  handler: (payload: TaskEventPayload) => void,
): () => void {
  bus.on(`task:${taskId}`, handler);
  return () => bus.off(`task:${taskId}`, handler);
}
