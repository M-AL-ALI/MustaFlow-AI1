import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = ["postgresql", "://", "test", ":", "test", "@127.0.0.1:1/test"].join(
    "",
  );
});

import {
  createDatabaseMemoryReconciliationObservationSource,
  MEMORY_RECONCILIATION_ROW_LIMIT,
  readProjectMemoryReconciliation,
  readProjectMemoryReconciliationSummary,
  reconcileProjectMemorySnapshot,
  type ProjectMemoryReconciliationSnapshot,
} from "./memory-reconciliation-reader";

const observedAt = new Date("2026-08-19T21:21:40.000Z");

function contentSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(): ProjectMemoryReconciliationSnapshot {
  const conversation = "A structural conversation summary";
  const knowledge = "A structurally bound knowledge entry";
  return {
    observedAt,
    project: {
      id: 52,
      lastTaskSummary: "The current build completed",
      lastTaskSummaryProvenance: {
        semantics: "project-summary-provenance-v1",
        sourceKind: "version",
        sourceIdentity: "opaque-version-source",
        taskId: null,
        versionId: 159,
        messageId: null,
        sourceProjectId: 52,
        actorUserId: "private-user",
        contentSha256: contentSha256("The current build completed"),
        recordedAt: observedAt.toISOString(),
      },
      summary: null,
      summaryProvenance: null,
    },
    messages: [
      {
        id: 11,
        projectId: 52,
        checkpointId: 158,
        origin: "zero",
        createdAt: observedAt,
      },
    ],
    tasks: [{ id: 245, projectId: 52, origin: "zero", createdAt: observedAt }],
    versions: [
      {
        id: 158,
        projectId: 52,
        planSnapshot: { private: "plan body" },
        planSourceMessageId: 11,
        createdAt: new Date("2026-08-19T20:00:00.000Z"),
      },
      {
        id: 159,
        projectId: 52,
        planSnapshot: null,
        planSourceMessageId: null,
        createdAt: new Date("2026-08-19T21:00:00.000Z"),
      },
    ],
    knowledgeEntries: [
      {
        id: 31,
        projectId: 52,
        userId: "private-user",
        origin: "builder",
        type: "conversation_summary",
        scope: "project",
        content: conversation,
        relatedTaskId: null,
        relatedVersionId: null,
        sourceMessageStartId: 11,
        sourceMessageEndId: 11,
        createdAt: observedAt,
      },
      {
        id: 32,
        projectId: 52,
        userId: "private-user",
        origin: "builder",
        type: "lesson",
        scope: "project",
        content: knowledge,
        relatedTaskId: 245,
        relatedVersionId: 158,
        sourceMessageStartId: null,
        sourceMessageEndId: null,
        createdAt: observedAt,
      },
    ],
    provenanceEvents: [
      {
        id: 401,
        knowledgeEntryId: 31,
        projectId: 52,
        sourceMessageStartId: 11,
        sourceMessageEndId: 11,
        sourceTaskId: null,
        sourceVersionId: null,
        resultingContentSha256: contentSha256(conversation),
        createdAt: observedAt,
      },
      {
        id: 402,
        knowledgeEntryId: 32,
        projectId: 52,
        sourceMessageStartId: null,
        sourceMessageEndId: null,
        sourceTaskId: 245,
        sourceVersionId: 158,
        resultingContentSha256: contentSha256(knowledge),
        createdAt: observedAt,
      },
    ],
  };
}

describe("Zero memory reconciliation reader", () => {
  it("reads and classifies all six registered surfaces with project-scoped fixtures", async () => {
    const source = { readProjectSnapshot: vi.fn(async (_projectId: number) => snapshot()) };
    const results = await readProjectMemoryReconciliation(52, source);
    expect(source.readProjectSnapshot).toHaveBeenCalledWith(52);
    expect(new Set(results.map(({ surfaceId }) => surfaceId))).toEqual(
      new Set([
        "chat-messages",
        "tasks",
        "project-summary",
        "conversation-summaries",
        "knowledge-entries",
        "plan-snapshots",
      ]),
    );
    expect(results.find(({ surfaceId }) => surfaceId === "project-summary")).toMatchObject({
      verdict: "confirmed",
      reason: "content_hash_confirmed",
    });
    expect(results.find(({ surfaceId }) => surfaceId === "conversation-summaries")).toMatchObject({
      verdict: "confirmed",
      reason: "content_hash_confirmed",
    });
    expect(results.find(({ surfaceId }) => surfaceId === "knowledge-entries")).toMatchObject({
      verdict: "confirmed",
      reason: "content_hash_confirmed",
    });
    expect(results.find(({ surfaceId }) => surfaceId === "plan-snapshots")).toMatchObject({
      verdict: "confirmed",
      reason: "authoritative_binding_confirmed",
    });
    expect(results.find(({ surfaceId }) => surfaceId === "chat-messages")).toMatchObject({
      verdict: "unverifiable",
      reason: "provenance_incomplete",
    });
    expect(results.find(({ surfaceId }) => surfaceId === "tasks")).toMatchObject({
      verdict: "unverifiable",
      reason: "version_binding_missing",
    });
  });

  it("uses the latest database-ordered provenance event for insert and reinforcement history", () => {
    const input = snapshot();
    const entry = input.knowledgeEntries.find(({ id }) => id === 32)!;
    input.provenanceEvents = [
      ...input.provenanceEvents,
      {
        id: 403,
        knowledgeEntryId: 32,
        projectId: 52,
        sourceMessageStartId: null,
        sourceMessageEndId: null,
        sourceTaskId: 245,
        sourceVersionId: 158,
        resultingContentSha256: contentSha256(`${entry.content} stale`),
        createdAt: new Date(observedAt.getTime() + 1_000),
      },
    ];
    expect(
      reconcileProjectMemorySnapshot(input).find(
        ({ surfaceId }) => surfaceId === "knowledge-entries",
      ),
    ).toMatchObject({ verdict: "stale", reason: "content_hash_mismatch" });
  });

  it("treats source loss as unverifiable and an affirmative cross-project source as stale", () => {
    const missing = snapshot();
    missing.knowledgeEntries = [
      {
        ...missing.knowledgeEntries[0]!,
        sourceMessageStartId: null,
        sourceMessageEndId: null,
      },
    ];
    missing.provenanceEvents = [
      {
        ...missing.provenanceEvents[0]!,
        sourceMessageStartId: null,
        sourceMessageEndId: null,
      },
    ];
    expect(
      reconcileProjectMemorySnapshot(missing).find(
        ({ surfaceId }) => surfaceId === "conversation-summaries",
      ),
    ).toMatchObject({ verdict: "unverifiable", reason: "source_missing" });

    const lostProjectEvidence = snapshot();
    lostProjectEvidence.provenanceEvents = [
      { ...lostProjectEvidence.provenanceEvents[1]!, projectId: null },
    ];
    expect(
      reconcileProjectMemorySnapshot(lostProjectEvidence).find(
        ({ surfaceId }) => surfaceId === "knowledge-entries",
      ),
    ).toMatchObject({ verdict: "unverifiable", reason: "provenance_incomplete" });

    const contradicted = snapshot();
    contradicted.knowledgeEntries = [{ ...contradicted.knowledgeEntries[1]! }];
    contradicted.provenanceEvents = [{ ...contradicted.provenanceEvents[1]!, projectId: 53 }];
    expect(
      reconcileProjectMemorySnapshot(contradicted).find(
        ({ surfaceId }) => surfaceId === "knowledge-entries",
      ),
    ).toMatchObject({ verdict: "stale", reason: "source_project_mismatch" });

    const summaryContradiction = snapshot();
    summaryContradiction.project = {
      ...summaryContradiction.project!,
      lastTaskSummaryProvenance: {
        ...summaryContradiction.project!.lastTaskSummaryProvenance!,
        sourceProjectId: 53,
      },
    };
    expect(
      reconcileProjectMemorySnapshot(summaryContradiction).find(
        ({ surfaceId }) => surfaceId === "project-summary",
      ),
    ).toMatchObject({ verdict: "stale", reason: "source_project_mismatch" });
  });

  it("returns stable sorted sanitized results and no secret-bearing source material", () => {
    const forward = reconcileProjectMemorySnapshot(snapshot());
    const reversed = snapshot();
    reversed.messages = [...reversed.messages].reverse();
    reversed.tasks = [...reversed.tasks].reverse();
    reversed.versions = [...reversed.versions].reverse();
    reversed.knowledgeEntries = [...reversed.knowledgeEntries].reverse();
    reversed.provenanceEvents = [...reversed.provenanceEvents].reverse();
    expect(reconcileProjectMemorySnapshot(reversed)).toEqual(forward);
    const json = JSON.stringify(forward);
    for (const forbidden of [
      "private-user",
      "The current build completed",
      "A structural conversation summary",
      "A structurally bound knowledge entry",
      "plan body",
      "sourceIdentity",
      "projectId",
      "recordId",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("executes only project-scoped SELECT queries in the database adapter", async () => {
    const fixture = snapshot();
    const rows = [
      [{ ...fixture.project, observedAt }],
      fixture.messages,
      fixture.tasks,
      fixture.versions,
      fixture.knowledgeEntries,
      fixture.provenanceEvents,
    ];
    const predicates: unknown[] = [];
    const limits: number[] = [];
    const select = vi.fn(() => {
      const result = rows.shift() ?? [];
      const query = {
        where: vi.fn((predicate: unknown) => {
          predicates.push(predicate);
          return query;
        }),
        orderBy: vi.fn(() => query),
        limit: vi.fn((limit: number) => {
          limits.push(limit);
          return Promise.resolve(result.slice(0, limit));
        }),
      };
      return {
        from: vi.fn(() => query),
      };
    });
    const writes = {
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
      execute: vi.fn(),
    };
    const source = createDatabaseMemoryReconciliationObservationSource({
      select,
      ...writes,
    } as never);
    const read = await source.readProjectSnapshot(52);
    expect(read.project?.id).toBe(52);
    expect(select).toHaveBeenCalledTimes(6);
    expect(predicates).toHaveLength(6);
    expect(limits).toEqual([
      1,
      MEMORY_RECONCILIATION_ROW_LIMIT + 1,
      MEMORY_RECONCILIATION_ROW_LIMIT + 1,
      MEMORY_RECONCILIATION_ROW_LIMIT + 1,
      MEMORY_RECONCILIATION_ROW_LIMIT + 1,
      MEMORY_RECONCILIATION_ROW_LIMIT + 1,
    ]);
    expect(read.coverage).toEqual({
      complete: true,
      rowLimit: MEMORY_RECONCILIATION_ROW_LIMIT,
      limitedSurfaces: [],
    });
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  });

  it("caps database reads and fails closed rather than calling partial coverage complete", async () => {
    const fixture = snapshot();
    const messages = Array.from({ length: MEMORY_RECONCILIATION_ROW_LIMIT + 1 }, (_, index) => ({
      ...fixture.messages[0]!,
      id: index + 1,
    }));
    const rows = [
      [{ ...fixture.project, observedAt }],
      messages,
      fixture.tasks,
      fixture.versions,
      fixture.knowledgeEntries,
      fixture.provenanceEvents,
    ];
    const select = vi.fn(() => {
      const result = rows.shift() ?? [];
      const query = {
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn((limit: number) => Promise.resolve(result.slice(0, limit))),
      };
      return { from: vi.fn(() => query) };
    });
    const writes = {
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
      execute: vi.fn(),
    };
    const source = createDatabaseMemoryReconciliationObservationSource({
      select,
      ...writes,
    } as never);

    const summary = await readProjectMemoryReconciliationSummary(52, source);

    expect(summary.status).toBe("limited");
    expect(summary.coverage).toEqual({
      complete: false,
      rowLimit: MEMORY_RECONCILIATION_ROW_LIMIT,
      limitedSurfaces: [
        "chat-messages",
        "conversation-summaries",
        "knowledge-entries",
        "plan-snapshots",
        "project-summary",
        "tasks",
      ],
    });
    expect(summary.surfaces.find(({ surfaceId }) => surfaceId === "chat-messages")).toMatchObject({
      status: "limited",
      unverifiable: MEMORY_RECONCILIATION_ROW_LIMIT,
    });
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  });

  it("statically guards the adapter module against writes, providers, and repair behavior", () => {
    const source = readFileSync(
      new URL("./memory-reconciliation-reader.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "database.insert(",
      "database.update(",
      "database.delete(",
      "database.transaction(",
      "fetch(",
      "axios",
      "usageCount",
      "reinforcedCount",
      "archive",
      "autoRepair",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source.match(/\.where\(eq\([^\n]+projectId/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
