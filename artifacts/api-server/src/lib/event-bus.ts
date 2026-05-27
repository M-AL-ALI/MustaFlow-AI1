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
  type: "added" | "removed" | "verified" | "updated" | "ssl_issued" | "error" | "snapshot";
  /** Hostname / bare domain string (e.g. "app.example.com") */
  domain: string;
  /** @deprecated use `domain` — kept for backward compat */
  hostname: string;
  projectId: number;
  domainId?: number;
  /** Primary status field — mirrors verificationStatus */
  status?: string;
  sslStatus?: string;
  verificationStatus?: string;
  error?: string;
}

export interface SecretEventPayload {
  projectId: number;
  secretId: number;
  action: "created" | "updated" | "deleted";
  secretName: string;
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

export function publishDomainEvent(
  payload: Omit<DomainEventPayload, "domain"> & { domain?: string },
): void {
  const normalized: DomainEventPayload = {
    ...payload,
    domain: payload.domain ?? payload.hostname,
    status: payload.status ?? payload.verificationStatus,
  };
  bus.emit(`domain:${payload.projectId}`, normalized);
  bus.emit("domain:change", normalized);
}

export function subscribeDomainEvents(handler: (payload: DomainEventPayload) => void): () => void {
  bus.on("domain:change", handler);
  return () => bus.off("domain:change", handler);
}

export function subscribeDomainProjectEvents(
  projectId: number,
  handler: (payload: DomainEventPayload) => void,
): () => void {
  const channel = `domain:${projectId}`;
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

export function publishSecretEvent(payload: SecretEventPayload): void {
  bus.emit(`secret:${payload.projectId}`, payload);
}

export function subscribeSecretEvents(
  projectId: number,
  handler: (payload: SecretEventPayload) => void,
): () => void {
  const channel = `secret:${projectId}`;
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

// ── Provisioning step events (Task #988) ──────────────────────────────────────

export interface ProvisioningStepPayload {
  projectId: number;
  /** Which named step just changed state. */
  step: "create_container" | "create_database" | "connect_and_test";
  /** The new state of that step. */
  state: "started" | "completed" | "failed";
  /** Human-readable error message — only present when state is "failed". */
  error?: string;
}

export function publishProvisioningStep(payload: ProvisioningStepPayload): void {
  bus.emit(`provisioning:step:${payload.projectId}`, payload);
}

export function subscribeProvisioningStep(
  projectId: number,
  handler: (payload: ProvisioningStepPayload) => void,
): () => void {
  const channel = `provisioning:step:${projectId}`;
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}
