import { EventEmitter } from "events";

export interface TaskEventPayload {
  id: number;
  taskId: number;
  eventType: string;
  message: string;
  filePath: string | null;
  createdAt: Date | string;
}

export interface ContainerLogPayload {
  id: number;
  projectId: number;
  level: "stdout" | "stderr" | "system";
  message: string;
  createdAt: Date | string;
}

export interface DomainEventPayload {
  type: "added" | "removed" | "verified" | "updated";
  hostname: string;
  projectId: number;
  domainId?: number;
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

export function publishContainerLog(payload: ContainerLogPayload): void {
  bus.emit(`container-log:${payload.projectId}`, payload);
}

export function subscribeContainerLogs(
  projectId: number,
  handler: (payload: ContainerLogPayload) => void,
): () => void {
  const channel = `container-log:${projectId}`;
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

export function publishDomainEvent(payload: DomainEventPayload): void {
  bus.emit("domain:change", payload);
}

export function subscribeDomainEvents(handler: (payload: DomainEventPayload) => void): () => void {
  bus.on("domain:change", handler);
  return () => bus.off("domain:change", handler);
}
