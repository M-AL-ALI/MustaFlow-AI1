import { createHash } from "node:crypto";

export const MEMORY_TRUTH_SEMANTICS = "zero-memory-truth-v1" as const;

export const MEMORY_SURFACE_IDS = [
  "chat-messages",
  "tasks",
  "project-summary",
  "conversation-summaries",
  "knowledge-entries",
  "plan-snapshots",
] as const;

export type MemorySurfaceId = (typeof MEMORY_SURFACE_IDS)[number];
export type MemoryScope = "project" | "user" | "global";
export type MemoryProvenanceStatus = "complete" | "partial" | "missing";
export type MemoryVersionBinding =
  | "exact-version"
  | "checkpoint"
  | "task-only"
  | "current-project"
  | "unbound";
export type MemoryDecisionClass = "decision" | "rejection" | "unclassified";
export type MemoryReconciliationStatus = "not-supported" | "not-run";

export class MemoryTruthContractError extends Error {
  readonly name = "MemoryTruthContractError";

  constructor(
    readonly code:
      | "memory_truth_source_unclassified"
      | "memory_truth_scope_invalid"
      | "memory_truth_version_binding_missing",
    message: string,
  ) {
    super(message);
  }
}

export type MemorySurfaceContract = {
  id: MemorySurfaceId;
  source: string;
  scopes: readonly MemoryScope[];
  producers: readonly string[];
  consumers: readonly string[];
  mutableByUser: boolean;
  deletionBehavior: "project-cascade" | "project-delete-unproven";
  contentSensitivity: "secret-bearing-user-content";
  currentProvenance: MemoryProvenanceStatus;
  currentVersionBinding: readonly MemoryVersionBinding[];
  reconciliationCapability: "not-supported";
  missingProvenance: readonly string[];
};

export const MEMORY_SURFACE_REGISTRY: readonly MemorySurfaceContract[] = [
  {
    id: "chat-messages",
    source: "chat_messages",
    scopes: ["project"],
    producers: ["routes/messages", "lib/jobs", "routes/checkpoints"],
    consumers: ["routes/messages", "lib/jobs", "routes/checkpoints"],
    mutableByUser: false,
    deletionBehavior: "project-cascade",
    contentSensitivity: "secret-bearing-user-content",
    currentProvenance: "partial",
    currentVersionBinding: ["checkpoint", "unbound"],
    reconciliationCapability: "not-supported",
    missingProvenance: ["authorUserId"],
  },
  {
    id: "tasks",
    source: "agent_tasks",
    scopes: ["project"],
    producers: ["routes/messages", "lib/jobs", "routes/tasks"],
    consumers: ["lib/jobs", "routes/events", "routes/tasks"],
    mutableByUser: false,
    deletionBehavior: "project-cascade",
    contentSensitivity: "secret-bearing-user-content",
    currentProvenance: "partial",
    currentVersionBinding: ["task-only"],
    reconciliationCapability: "not-supported",
    missingProvenance: ["initiatingUserId", "originatingVersionId"],
  },
  {
    id: "project-summary",
    source: "projects.last_task_summary+projects.summary",
    scopes: ["project"],
    producers: ["lib/jobs", "routes/checkpoints"],
    consumers: ["routes/projects", "lib/jobs"],
    mutableByUser: false,
    deletionBehavior: "project-cascade",
    contentSensitivity: "secret-bearing-user-content",
    currentProvenance: "missing",
    currentVersionBinding: ["current-project"],
    reconciliationCapability: "not-supported",
    missingProvenance: ["sourceRecordId", "sourceTaskId", "sourceVersionId"],
  },
  {
    id: "conversation-summaries",
    source: "knowledge_entries:type=conversation_summary",
    scopes: ["project"],
    producers: ["routes/messages:conversation-summary"],
    consumers: ["lib/jobs:conversation-summary"],
    mutableByUser: true,
    deletionBehavior: "project-delete-unproven",
    contentSensitivity: "secret-bearing-user-content",
    currentProvenance: "partial",
    currentVersionBinding: ["unbound"],
    reconciliationCapability: "not-supported",
    missingProvenance: ["sourceMessageRange", "relatedTaskId", "relatedVersionId"],
  },
  {
    id: "knowledge-entries",
    source: "knowledge_entries",
    scopes: ["project", "user", "global"],
    producers: ["lib/knowledge", "routes/knowledge"],
    consumers: ["lib/jobs:loadKnowledgeContext", "routes/knowledge"],
    mutableByUser: true,
    deletionBehavior: "project-delete-unproven",
    contentSensitivity: "secret-bearing-user-content",
    currentProvenance: "partial",
    currentVersionBinding: ["exact-version", "task-only", "unbound"],
    reconciliationCapability: "not-supported",
    missingProvenance: ["nullableOrigin", "nullableActor", "nullableTaskOrVersion"],
  },
  {
    id: "plan-snapshots",
    source: "project_versions.plan_snapshot",
    scopes: ["project"],
    producers: ["lib/jobs:loadLatestPlanSnapshot"],
    consumers: ["routes/checkpoints", "routes/versions"],
    mutableByUser: false,
    deletionBehavior: "project-cascade",
    contentSensitivity: "secret-bearing-user-content",
    currentProvenance: "partial",
    currentVersionBinding: ["exact-version"],
    reconciliationCapability: "not-supported",
    missingProvenance: ["sourceMessageId"],
  },
] as const;

export type MemoryTruthRecordInput = {
  surfaceId: MemorySurfaceId;
  recordId: string | number;
  projectId: number | null;
  scope: MemoryScope;
  createdAt?: Date | string | null;
  origin?: string | null;
  actorUserId?: string | null;
  taskId?: number | null;
  versionId?: number | null;
  checkpointId?: number | null;
  decisionClass?: MemoryDecisionClass;
};

export type MemoryTruthRecord = {
  semantics: typeof MEMORY_TRUTH_SEMANTICS;
  surfaceId: MemorySurfaceId;
  recordIdentitySha256: string;
  projectId: number | null;
  scope: MemoryScope;
  createdAt: string | null;
  origin: string | null;
  actorUserIdPresent: boolean;
  taskId: number | null;
  versionId: number | null;
  checkpointId: number | null;
  provenanceStatus: MemoryProvenanceStatus;
  missingProvenance: readonly string[];
  versionBinding: MemoryVersionBinding;
  decisionClass: MemoryDecisionClass;
  reconciliationStatus: MemoryReconciliationStatus;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function contractFor(surfaceId: MemorySurfaceId): MemorySurfaceContract {
  const contract = MEMORY_SURFACE_REGISTRY.find((entry) => entry.id === surfaceId);
  if (!contract) {
    throw new MemoryTruthContractError(
      "memory_truth_source_unclassified",
      `Unclassified Zero memory source: ${String(surfaceId)}`,
    );
  }
  return contract;
}

function versionBindingFor(input: MemoryTruthRecordInput): MemoryVersionBinding {
  if (input.surfaceId === "plan-snapshots") {
    if (input.versionId == null) {
      throw new MemoryTruthContractError(
        "memory_truth_version_binding_missing",
        "Plan snapshot memory requires an exact version binding",
      );
    }
    return "exact-version";
  }
  if (input.versionId != null) return "exact-version";
  if (input.surfaceId === "chat-messages" && input.checkpointId != null) return "checkpoint";
  if (input.surfaceId === "tasks" || input.taskId != null) return "task-only";
  if (input.surfaceId === "project-summary") return "current-project";
  return "unbound";
}

function normalizedTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

export function buildMemoryTruthRecord(input: MemoryTruthRecordInput): MemoryTruthRecord {
  const contract = contractFor(input.surfaceId);
  if (!contract.scopes.includes(input.scope)) {
    throw new MemoryTruthContractError(
      "memory_truth_scope_invalid",
      `Memory scope ${input.scope} is invalid for ${input.surfaceId}`,
    );
  }
  if (input.scope === "project" && input.projectId == null) {
    throw new MemoryTruthContractError(
      "memory_truth_scope_invalid",
      `Project-scoped memory requires a project identity for ${input.surfaceId}`,
    );
  }
  const recordId = String(input.recordId);
  const createdAt = normalizedTimestamp(input.createdAt);
  const identityInput = {
    semantics: MEMORY_TRUTH_SEMANTICS,
    surfaceId: input.surfaceId,
    recordId,
    projectId: input.projectId,
    scope: input.scope,
    createdAt,
    origin: input.origin ?? null,
    taskId: input.taskId ?? null,
    versionId: input.versionId ?? null,
    checkpointId: input.checkpointId ?? null,
  };

  return {
    semantics: MEMORY_TRUTH_SEMANTICS,
    surfaceId: input.surfaceId,
    recordIdentitySha256: sha256(identityInput),
    projectId: input.projectId,
    scope: input.scope,
    createdAt,
    origin: input.origin ?? null,
    actorUserIdPresent: Boolean(input.actorUserId),
    taskId: input.taskId ?? null,
    versionId: input.versionId ?? null,
    checkpointId: input.checkpointId ?? null,
    provenanceStatus: contract.currentProvenance,
    missingProvenance: contract.missingProvenance,
    versionBinding: versionBindingFor(input),
    decisionClass: input.decisionClass ?? "unclassified",
    reconciliationStatus: contract.reconciliationCapability,
  };
}

export function buildMemoryTruthInventory(
  inputs: readonly MemoryTruthRecordInput[],
): readonly MemoryTruthRecord[] {
  return inputs
    .map((input) => buildMemoryTruthRecord(input))
    .sort((left, right) =>
      `${left.surfaceId}:${left.recordIdentitySha256}`.localeCompare(
        `${right.surfaceId}:${right.recordIdentitySha256}`,
      ),
    );
}

export function memoryTruthRegistryIdentitySha256(): string {
  return sha256({ semantics: MEMORY_TRUTH_SEMANTICS, sources: MEMORY_SURFACE_REGISTRY });
}

export function assertMemorySourcesClassified(sourceIds: readonly string[]): void {
  const known = new Set<string>(MEMORY_SURFACE_IDS);
  const unknown = [...new Set(sourceIds)].filter((sourceId) => !known.has(sourceId)).sort();
  if (unknown.length > 0) {
    throw new MemoryTruthContractError(
      "memory_truth_source_unclassified",
      `Unclassified Zero memory sources: ${unknown.join(", ")}`,
    );
  }
}

export const MEMORY_TRUTH_SOURCE_CENSUS = [
  { id: "chat-messages", path: "lib/db/src/schema/messages.ts", token: "chatMessagesTable" },
  { id: "tasks", path: "lib/db/src/schema/tasks.ts", token: "agentTasksTable" },
  {
    id: "project-summary",
    path: "lib/db/src/schema/projects.ts",
    token: "lastTaskSummary",
  },
  {
    id: "conversation-summaries",
    path: "artifacts/api-server/src/routes/messages.ts",
    token: 'type: "conversation_summary"',
  },
  {
    id: "knowledge-entries",
    path: "lib/db/src/schema/knowledge.ts",
    token: "knowledgeEntriesTable",
  },
  {
    id: "plan-snapshots",
    path: "lib/db/src/schema/versions.ts",
    token: "planSnapshot",
  },
] as const satisfies ReadonlyArray<{ id: MemorySurfaceId; path: string; token: string }>;
