import { createHash } from "node:crypto";
import {
  agentTasksTable,
  chatMessagesTable,
  db,
  knowledgeEntriesTable,
  knowledgeProvenanceEventsTable,
  projectsTable,
  projectVersionsTable,
  type ProjectSummaryProvenance,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { buildMemoryTruthRecord, MEMORY_SURFACE_IDS, type MemorySurfaceId } from "./memory-truth";
import {
  reconcileMemoryRecords,
  summarizeProjectMemoryReconciliation,
  type MemoryReconciliationCheck,
  type MemoryReconciliationObservation,
  type MemoryReconciliationResult,
  type ProjectMemoryReconciliationSummary,
} from "./memory-reconciliation";

type ProjectRow = {
  id: number;
  lastTaskSummary: string | null;
  lastTaskSummaryProvenance: ProjectSummaryProvenance | null;
  summary: string | null;
  summaryProvenance: ProjectSummaryProvenance | null;
};

type MessageRow = {
  id: number;
  projectId: number;
  checkpointId: number | null;
  origin: string | null;
  createdAt: Date;
};

type TaskRow = {
  id: number;
  projectId: number;
  origin: string | null;
  createdAt: Date;
};

type VersionRow = {
  id: number;
  projectId: number;
  planSnapshot: Record<string, unknown> | null;
  planSourceMessageId: number | null;
  createdAt: Date;
};

type KnowledgeRow = {
  id: number;
  projectId: number | null;
  userId: string | null;
  origin: string | null;
  type: string;
  scope: string;
  content: string;
  relatedTaskId: number | null;
  relatedVersionId: number | null;
  sourceMessageStartId: number | null;
  sourceMessageEndId: number | null;
  createdAt: Date;
};

type ProvenanceRow = {
  id: number;
  knowledgeEntryId: number;
  projectId: number | null;
  sourceMessageStartId: number | null;
  sourceMessageEndId: number | null;
  sourceTaskId: number | null;
  sourceVersionId: number | null;
  resultingContentSha256: string;
  createdAt: Date;
};

export type ProjectMemoryReconciliationSnapshot = {
  observedAt: Date | string;
  project: ProjectRow | null;
  messages: readonly MessageRow[];
  tasks: readonly TaskRow[];
  versions: readonly VersionRow[];
  knowledgeEntries: readonly KnowledgeRow[];
  provenanceEvents: readonly ProvenanceRow[];
  coverage?: {
    complete: boolean;
    rowLimit: number;
    limitedSurfaces: readonly MemorySurfaceId[];
  };
};

export type MemoryReconciliationObservationSource = {
  readProjectSnapshot(projectId: number): Promise<ProjectMemoryReconciliationSnapshot>;
};

type MemorySelectDatabase = Pick<typeof db, "select">;

export const MEMORY_RECONCILIATION_ROW_LIMIT = 500;

function boundedRows<T>(rows: readonly T[]): { rows: readonly T[]; limited: boolean } {
  return {
    rows: rows.slice(0, MEMORY_RECONCILIATION_ROW_LIMIT),
    limited: rows.length > MEMORY_RECONCILIATION_ROW_LIMIT,
  };
}

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

function contentSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createDatabaseMemoryReconciliationObservationSource(
  database: MemorySelectDatabase = db,
): MemoryReconciliationObservationSource {
  return {
    async readProjectSnapshot(projectId) {
      const [projects, messages, tasks, versions, knowledgeEntries, provenanceEvents] =
        await Promise.all([
          database
            .select({
              id: projectsTable.id,
              lastTaskSummary: projectsTable.lastTaskSummary,
              lastTaskSummaryProvenance: projectsTable.lastTaskSummaryProvenance,
              summary: projectsTable.summary,
              summaryProvenance: projectsTable.summaryProvenance,
              observedAt: sql<Date>`CURRENT_TIMESTAMP`,
            })
            .from(projectsTable)
            .where(eq(projectsTable.id, projectId))
            .limit(1),
          database
            .select({
              id: chatMessagesTable.id,
              projectId: chatMessagesTable.projectId,
              checkpointId: chatMessagesTable.checkpointId,
              origin: chatMessagesTable.origin,
              createdAt: chatMessagesTable.createdAt,
            })
            .from(chatMessagesTable)
            .where(eq(chatMessagesTable.projectId, projectId))
            .orderBy(desc(chatMessagesTable.id))
            .limit(MEMORY_RECONCILIATION_ROW_LIMIT + 1),
          database
            .select({
              id: agentTasksTable.id,
              projectId: agentTasksTable.projectId,
              origin: agentTasksTable.origin,
              createdAt: agentTasksTable.createdAt,
            })
            .from(agentTasksTable)
            .where(eq(agentTasksTable.projectId, projectId))
            .orderBy(desc(agentTasksTable.id))
            .limit(MEMORY_RECONCILIATION_ROW_LIMIT + 1),
          database
            .select({
              id: projectVersionsTable.id,
              projectId: projectVersionsTable.projectId,
              planSnapshot: projectVersionsTable.planSnapshot,
              planSourceMessageId: projectVersionsTable.planSourceMessageId,
              createdAt: projectVersionsTable.createdAt,
            })
            .from(projectVersionsTable)
            .where(eq(projectVersionsTable.projectId, projectId))
            .orderBy(desc(projectVersionsTable.id))
            .limit(MEMORY_RECONCILIATION_ROW_LIMIT + 1),
          database
            .select({
              id: knowledgeEntriesTable.id,
              projectId: knowledgeEntriesTable.projectId,
              userId: knowledgeEntriesTable.userId,
              origin: knowledgeEntriesTable.origin,
              type: knowledgeEntriesTable.type,
              scope: knowledgeEntriesTable.scope,
              content: knowledgeEntriesTable.content,
              relatedTaskId: knowledgeEntriesTable.relatedTaskId,
              relatedVersionId: knowledgeEntriesTable.relatedVersionId,
              sourceMessageStartId: knowledgeEntriesTable.sourceMessageStartId,
              sourceMessageEndId: knowledgeEntriesTable.sourceMessageEndId,
              createdAt: knowledgeEntriesTable.createdAt,
            })
            .from(knowledgeEntriesTable)
            .where(eq(knowledgeEntriesTable.projectId, projectId))
            .orderBy(desc(knowledgeEntriesTable.id))
            .limit(MEMORY_RECONCILIATION_ROW_LIMIT + 1),
          database
            .select({
              id: knowledgeProvenanceEventsTable.id,
              knowledgeEntryId: knowledgeProvenanceEventsTable.knowledgeEntryId,
              projectId: knowledgeProvenanceEventsTable.projectId,
              sourceMessageStartId: knowledgeProvenanceEventsTable.sourceMessageStartId,
              sourceMessageEndId: knowledgeProvenanceEventsTable.sourceMessageEndId,
              sourceTaskId: knowledgeProvenanceEventsTable.sourceTaskId,
              sourceVersionId: knowledgeProvenanceEventsTable.sourceVersionId,
              resultingContentSha256: knowledgeProvenanceEventsTable.resultingContentSha256,
              createdAt: knowledgeProvenanceEventsTable.createdAt,
            })
            .from(knowledgeProvenanceEventsTable)
            .where(eq(knowledgeProvenanceEventsTable.projectId, projectId))
            .orderBy(desc(knowledgeProvenanceEventsTable.id))
            .limit(MEMORY_RECONCILIATION_ROW_LIMIT + 1),
        ]);
      const project = projects[0] ?? null;
      const boundedMessages = boundedRows(messages);
      const boundedTasks = boundedRows(tasks);
      const boundedVersions = boundedRows(versions);
      const boundedKnowledge = boundedRows(knowledgeEntries);
      const boundedProvenance = boundedRows(provenanceEvents);
      const coverageLimited = [
        boundedMessages,
        boundedTasks,
        boundedVersions,
        boundedKnowledge,
        boundedProvenance,
      ].some(({ limited }) => limited);
      return {
        observedAt: project?.observedAt ?? new Date(0),
        project,
        messages: boundedMessages.rows,
        tasks: boundedTasks.rows,
        versions: boundedVersions.rows,
        knowledgeEntries: boundedKnowledge.rows,
        provenanceEvents: boundedProvenance.rows,
        coverage: {
          complete: !coverageLimited,
          rowLimit: MEMORY_RECONCILIATION_ROW_LIMIT,
          limitedSurfaces: coverageLimited ? MEMORY_SURFACE_IDS : [],
        },
      };
    },
  };
}

function check(
  identity: MemoryReconciliationCheck["identity"],
  outcome: MemoryReconciliationCheck["outcome"],
): MemoryReconciliationCheck {
  return { identity, outcome };
}

function observation(
  recordIdentitySha256: string,
  observedAt: Date | string,
  checks: readonly MemoryReconciliationCheck[],
): MemoryReconciliationObservation {
  return {
    observationIdentitySha256: sha256({ recordIdentitySha256, checks }),
    observedAt,
    checks,
  };
}

function latestVersionId(versions: readonly VersionRow[]): number | null {
  return (
    [...versions].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id - left.id,
    )[0]?.id ?? null
  );
}

function latestEventFor(entryId: number, events: readonly ProvenanceRow[]): ProvenanceRow | null {
  return (
    events
      .filter(({ knowledgeEntryId }) => knowledgeEntryId === entryId)
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id - left.id,
      )[0] ?? null
  );
}

function sourceChecks(
  source: {
    taskId?: number | null;
    versionId?: number | null;
    messageIds?: readonly (number | null)[];
  },
  snapshot: ProjectMemoryReconciliationSnapshot,
): readonly MemoryReconciliationCheck[] {
  const declared = [source.taskId, source.versionId, ...(source.messageIds ?? [])].filter(
    (value): value is number => value != null,
  );
  if (declared.length === 0) return [check("source-exists", "missing")];

  const taskAgrees = source.taskId == null || snapshot.tasks.some(({ id }) => id === source.taskId);
  const versionAgrees =
    source.versionId == null || snapshot.versions.some(({ id }) => id === source.versionId);
  const messagesAgree = (source.messageIds ?? []).every(
    (id) => id == null || snapshot.messages.some(({ id: candidate }) => candidate === id),
  );
  const agrees = taskAgrees && versionAgrees && messagesAgree;
  return [
    check("source-exists", agrees ? "confirmed" : "missing"),
    check("source-project-binding", agrees ? "confirmed" : "contradicted"),
  ];
}

function summaryInputs(snapshot: ProjectMemoryReconciliationSnapshot): readonly {
  record: ReturnType<typeof buildMemoryTruthRecord>;
  observation: MemoryReconciliationObservation;
}[] {
  if (!snapshot.project) return [];
  const fields = [
    {
      identity: "last-task-summary",
      value: snapshot.project.lastTaskSummary,
      provenance: snapshot.project.lastTaskSummaryProvenance,
    },
    {
      identity: "summary",
      value: snapshot.project.summary,
      provenance: snapshot.project.summaryProvenance,
    },
  ] as const;
  const currentVersionId = latestVersionId(snapshot.versions);
  return fields.flatMap(({ identity, value, provenance }) => {
    if (value == null) return [];
    const record = buildMemoryTruthRecord({
      surfaceId: "project-summary",
      recordId: `${identity}:${snapshot.project!.id}`,
      projectId: snapshot.project!.id,
      scope: "project",
      createdAt: provenance?.recordedAt,
      origin: provenance?.sourceKind,
      actorUserId: provenance?.actorUserId,
      taskId: provenance?.taskId,
      versionId: provenance?.versionId,
    });
    const checks: MemoryReconciliationCheck[] = [
      check("observation-available", "confirmed"),
      check("record-exists", "confirmed"),
      check("project-binding", "confirmed"),
      check("provenance-complete", provenance ? "confirmed" : "missing"),
    ];
    if (provenance) {
      const provenanceSourceChecks = sourceChecks(
        {
          taskId: provenance.taskId,
          versionId: provenance.versionId,
          messageIds: [provenance.messageId],
        },
        snapshot,
      ).map((sourceCheck) =>
        sourceCheck.identity === "source-project-binding" &&
        provenance.sourceProjectId != null &&
        provenance.sourceProjectId !== snapshot.project!.id
          ? check("source-project-binding", "contradicted")
          : sourceCheck,
      );
      checks.push(
        check(
          "content-hash",
          contentSha256(value) === provenance.contentSha256 ? "confirmed" : "contradicted",
        ),
        ...provenanceSourceChecks,
        check("version-binding", provenance.versionId == null ? "missing" : "confirmed"),
        check(
          "current-project-version",
          provenance.versionId != null &&
            currentVersionId != null &&
            provenance.versionId !== currentVersionId
            ? "contradicted"
            : "confirmed",
        ),
      );
    }
    return [
      {
        record,
        observation: observation(record.recordIdentitySha256, snapshot.observedAt, checks),
      },
    ];
  });
}

function knowledgeInput(
  entry: KnowledgeRow,
  surfaceId: Extract<MemorySurfaceId, "conversation-summaries" | "knowledge-entries">,
  snapshot: ProjectMemoryReconciliationSnapshot,
) {
  const event = latestEventFor(entry.id, snapshot.provenanceEvents);
  const versionId = event?.sourceVersionId ?? entry.relatedVersionId;
  const taskId = event?.sourceTaskId ?? entry.relatedTaskId;
  const messageIds = [
    event?.sourceMessageStartId ?? entry.sourceMessageStartId,
    event?.sourceMessageEndId ?? entry.sourceMessageEndId,
  ];
  const scope = entry.scope === "user" || entry.scope === "global" ? entry.scope : "project";
  const record = buildMemoryTruthRecord({
    surfaceId,
    recordId: entry.id,
    projectId: entry.projectId,
    scope,
    createdAt: entry.createdAt,
    origin: entry.origin,
    actorUserId: entry.userId,
    taskId,
    versionId,
  });
  const sources = sourceChecks({ taskId, versionId, messageIds }, snapshot).map((sourceCheck) => {
    if (sourceCheck.identity !== "source-project-binding" || !event) return sourceCheck;
    if (event.projectId == null) return check("source-project-binding", "unavailable");
    return check(
      "source-project-binding",
      event.projectId === snapshot.project?.id ? sourceCheck.outcome : "contradicted",
    );
  });
  const checks: MemoryReconciliationCheck[] = [
    check("observation-available", "confirmed"),
    check("record-exists", "confirmed"),
    check(
      "project-binding",
      entry.projectId === snapshot.project?.id ? "confirmed" : "contradicted",
    ),
    check("provenance-complete", event?.projectId != null ? "confirmed" : "missing"),
    ...sources,
  ];
  if (event) {
    checks.push(
      check(
        "content-hash",
        contentSha256(entry.content) === event.resultingContentSha256
          ? "confirmed"
          : "contradicted",
      ),
    );
  }
  if (surfaceId === "knowledge-entries") {
    checks.push(check("version-binding", versionId == null ? "missing" : "confirmed"));
  }
  return {
    record,
    observation: observation(record.recordIdentitySha256, snapshot.observedAt, checks),
  };
}

export function reconcileProjectMemorySnapshot(
  snapshot: ProjectMemoryReconciliationSnapshot,
): readonly MemoryReconciliationResult[] {
  if (!snapshot.project) return [];
  const projectId = snapshot.project.id;
  const inputs: Array<{
    record: ReturnType<typeof buildMemoryTruthRecord>;
    observation: MemoryReconciliationObservation;
  }> = [];

  for (const message of snapshot.messages) {
    const record = buildMemoryTruthRecord({
      surfaceId: "chat-messages",
      recordId: message.id,
      projectId: message.projectId,
      scope: "project",
      createdAt: message.createdAt,
      origin: message.origin,
      checkpointId: message.checkpointId,
    });
    const checkpointAgrees =
      message.checkpointId == null ||
      snapshot.versions.some(({ id }) => id === message.checkpointId);
    const checks = [
      check("observation-available", "confirmed"),
      check("record-exists", "confirmed"),
      check("project-binding", message.projectId === projectId ? "confirmed" : "contradicted"),
      check("provenance-complete", "missing"),
      check("version-binding", message.checkpointId == null ? "missing" : "confirmed"),
      ...(message.checkpointId == null
        ? []
        : [
            check("source-exists", checkpointAgrees ? "confirmed" : "missing"),
            check("source-project-binding", checkpointAgrees ? "confirmed" : "contradicted"),
          ]),
    ];
    inputs.push({
      record,
      observation: observation(record.recordIdentitySha256, snapshot.observedAt, checks),
    });
  }

  for (const task of snapshot.tasks) {
    const record = buildMemoryTruthRecord({
      surfaceId: "tasks",
      recordId: task.id,
      projectId: task.projectId,
      scope: "project",
      createdAt: task.createdAt,
      origin: task.origin,
      taskId: task.id,
    });
    const checks = [
      check("observation-available", "confirmed"),
      check("record-exists", "confirmed"),
      check("project-binding", task.projectId === projectId ? "confirmed" : "contradicted"),
      check("source-exists", "confirmed"),
      check("source-project-binding", "confirmed"),
      check("version-binding", "missing"),
      check("provenance-complete", "missing"),
    ];
    inputs.push({
      record,
      observation: observation(record.recordIdentitySha256, snapshot.observedAt, checks),
    });
  }

  inputs.push(...summaryInputs(snapshot));

  for (const entry of snapshot.knowledgeEntries) {
    inputs.push(
      knowledgeInput(
        entry,
        entry.type === "conversation_summary" ? "conversation-summaries" : "knowledge-entries",
        snapshot,
      ),
    );
  }

  for (const version of snapshot.versions.filter(({ planSnapshot }) => planSnapshot != null)) {
    const record = buildMemoryTruthRecord({
      surfaceId: "plan-snapshots",
      recordId: version.id,
      projectId: version.projectId,
      scope: "project",
      createdAt: version.createdAt,
      versionId: version.id,
    });
    const sourceAgrees =
      version.planSourceMessageId != null &&
      snapshot.messages.some(({ id }) => id === version.planSourceMessageId);
    const checks = [
      check("observation-available", "confirmed"),
      check("record-exists", "confirmed"),
      check("project-binding", version.projectId === projectId ? "confirmed" : "contradicted"),
      check("version-binding", "confirmed"),
      check("provenance-complete", version.planSourceMessageId == null ? "missing" : "confirmed"),
      check("source-exists", sourceAgrees ? "confirmed" : "missing"),
      ...(version.planSourceMessageId == null
        ? []
        : [check("source-project-binding", sourceAgrees ? "confirmed" : "contradicted")]),
    ];
    inputs.push({
      record,
      observation: observation(record.recordIdentitySha256, snapshot.observedAt, checks),
    });
  }

  return reconcileMemoryRecords(inputs);
}

const databaseObservationSource = createDatabaseMemoryReconciliationObservationSource();

export async function readProjectMemoryReconciliation(
  projectId: number,
  source: MemoryReconciliationObservationSource = databaseObservationSource,
): Promise<readonly MemoryReconciliationResult[]> {
  return reconcileProjectMemorySnapshot(await source.readProjectSnapshot(projectId));
}

export async function readProjectMemoryReconciliationSummary(
  projectId: number,
  source: MemoryReconciliationObservationSource = databaseObservationSource,
): Promise<ProjectMemoryReconciliationSummary> {
  const snapshot = await source.readProjectSnapshot(projectId);
  return summarizeProjectMemoryReconciliation(reconcileProjectMemorySnapshot(snapshot), {
    limitedSurfaces: snapshot.coverage?.limitedSurfaces,
    rowLimit: snapshot.coverage?.rowLimit ?? null,
  });
}
