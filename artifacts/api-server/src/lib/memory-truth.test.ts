import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertMemorySourcesClassified,
  buildMemoryTruthInventory,
  buildMemoryTruthRecord,
  MEMORY_SURFACE_IDS,
  MEMORY_SURFACE_REGISTRY,
  MEMORY_TRUTH_SOURCE_CENSUS,
  memoryTruthRegistryIdentitySha256,
  type MemoryTruthRecordInput,
} from "./memory-truth";

const fixtures: readonly MemoryTruthRecordInput[] = [
  { surfaceId: "chat-messages", recordId: 1, projectId: 52, scope: "project", checkpointId: 158 },
  { surfaceId: "tasks", recordId: 2, projectId: 52, scope: "project", taskId: 245 },
  { surfaceId: "project-summary", recordId: 52, projectId: 52, scope: "project" },
  {
    surfaceId: "conversation-summaries",
    recordId: 3,
    projectId: 52,
    scope: "project",
    origin: "builder",
  },
  {
    surfaceId: "knowledge-entries",
    recordId: 4,
    projectId: 52,
    scope: "project",
    origin: "builder",
    versionId: 158,
  },
  { surfaceId: "plan-snapshots", recordId: 158, projectId: 52, scope: "project", versionId: 158 },
];

describe("Zero memory truth registry", () => {
  it("classifies exactly the six Phase 0 memory surfaces", () => {
    expect(MEMORY_SURFACE_REGISTRY.map(({ id }) => id)).toEqual(MEMORY_SURFACE_IDS);
    expect(new Set(MEMORY_SURFACE_IDS).size).toBe(6);
    expect(memoryTruthRegistryIdentitySha256()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires a complete policy contract for every registered surface", () => {
    for (const contract of MEMORY_SURFACE_REGISTRY) {
      expect(contract.source).not.toBe("");
      expect(contract.producers.length).toBeGreaterThan(0);
      expect(contract.consumers.length).toBeGreaterThan(0);
      expect(contract.scopes.length).toBeGreaterThan(0);
      expect(contract.currentVersionBinding.length).toBeGreaterThan(0);
      expect(contract.reconciliationCapability).toBe("not-supported");
      expect(contract.missingProvenance.length).toBeGreaterThan(0);
    }
  });

  it("pins the honest provenance and version-binding matrix", () => {
    const inventory = buildMemoryTruthInventory(fixtures);
    const bySurface = Object.fromEntries(inventory.map((row) => [row.surfaceId, row]));
    expect(bySurface["chat-messages"]).toMatchObject({
      provenanceStatus: "partial",
      versionBinding: "checkpoint",
    });
    expect(bySurface.tasks).toMatchObject({
      provenanceStatus: "partial",
      versionBinding: "task-only",
    });
    expect(bySurface["project-summary"]).toMatchObject({
      provenanceStatus: "missing",
      versionBinding: "current-project",
    });
    expect(bySurface["conversation-summaries"]).toMatchObject({
      provenanceStatus: "partial",
      versionBinding: "unbound",
    });
    expect(bySurface["knowledge-entries"]).toMatchObject({
      provenanceStatus: "partial",
      versionBinding: "exact-version",
    });
    expect(bySurface["plan-snapshots"]).toMatchObject({
      provenanceStatus: "partial",
      versionBinding: "exact-version",
    });
  });

  it("is order-independent and changes identity when public metadata changes", () => {
    const forward = buildMemoryTruthInventory(fixtures);
    const reverse = buildMemoryTruthInventory([...fixtures].reverse());
    expect(reverse).toEqual(forward);
    expect(buildMemoryTruthRecord(fixtures[0]!).recordIdentitySha256).not.toBe(
      buildMemoryTruthRecord({ ...fixtures[0]!, checkpointId: 159 }).recordIdentitySha256,
    );
  });

  it("never carries secret-bearing memory bodies into inventory output", () => {
    const hostile = {
      ...fixtures[0],
      content: "private message",
      prompt: "private prompt",
      summary: "private summary",
      plan: { body: "private plan" },
      attachments: ["private attachment"],
      embedding: [0.1],
      credential: "private credential",
      rawTransportDetail: "private transport",
    } as MemoryTruthRecordInput & Record<string, unknown>;
    const record = buildMemoryTruthRecord(hostile);
    const json = JSON.stringify(record);
    expect(Object.keys(record)).not.toEqual(
      expect.arrayContaining([
        "content",
        "prompt",
        "summary",
        "plan",
        "attachments",
        "embedding",
        "credential",
        "rawTransportDetail",
        "recordId",
      ]),
    );
    for (const forbidden of [
      "private message",
      "private prompt",
      "private summary",
      "private plan",
      "private attachment",
      "private credential",
      "private transport",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("collects inventory repeatedly without dispatching a write", () => {
    const writeSpy = vi.fn();
    expect(buildMemoryTruthInventory(fixtures)).toEqual(buildMemoryTruthInventory(fixtures));
    expect(writeSpy).not.toHaveBeenCalled();
    const source = readFileSync(new URL("./memory-truth.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@workspace/db");
    expect(source).not.toContain("db.transaction");
  });

  it("distinguishes project memory from intentional user/global knowledge", () => {
    expect(() =>
      buildMemoryTruthRecord({
        surfaceId: "chat-messages",
        recordId: 1,
        projectId: 52,
        scope: "global",
      }),
    ).toThrow("Memory scope global is invalid for chat-messages");
    expect(
      buildMemoryTruthRecord({
        surfaceId: "knowledge-entries",
        recordId: 2,
        projectId: null,
        scope: "user",
      }).scope,
    ).toBe("user");
    expect(() =>
      buildMemoryTruthRecord({
        surfaceId: "knowledge-entries",
        recordId: 2,
        projectId: null,
        scope: "project",
      }),
    ).toThrow("Project-scoped memory requires a project identity");
  });

  it("keeps rollback bindings exact and leaves weaker bindings honestly weaker", () => {
    const exact158 = buildMemoryTruthRecord({
      surfaceId: "knowledge-entries",
      recordId: 8,
      projectId: 52,
      scope: "project",
      versionId: 158,
    });
    const exact159 = buildMemoryTruthRecord({
      surfaceId: "knowledge-entries",
      recordId: 8,
      projectId: 52,
      scope: "project",
      versionId: 159,
    });
    expect(exact158).toMatchObject({ versionBinding: "exact-version", versionId: 158 });
    expect(exact159).toMatchObject({ versionBinding: "exact-version", versionId: 159 });
    expect(exact159.recordIdentitySha256).not.toBe(exact158.recordIdentitySha256);
    expect(buildMemoryTruthRecord(fixtures[1]!).versionBinding).toBe("task-only");
    expect(buildMemoryTruthRecord(fixtures[2]!).versionBinding).toBe("current-project");
    expect(buildMemoryTruthRecord(fixtures[3]!).versionBinding).toBe("unbound");
    expect(() =>
      buildMemoryTruthRecord({
        surfaceId: "plan-snapshots",
        recordId: 160,
        projectId: 52,
        scope: "project",
      }),
    ).toThrow("Plan snapshot memory requires an exact version binding");
  });

  it("fails closed for an unclassified durable memory source", () => {
    expect(() =>
      assertMemorySourcesClassified([...MEMORY_SURFACE_IDS, "new-memory-table"]),
    ).toThrow("Unclassified Zero memory sources: new-memory-table");
  });

  it("keeps every registered source anchored to its inspected repository source", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    assertMemorySourcesClassified(MEMORY_TRUTH_SOURCE_CENSUS.map(({ id }) => id));
    expect(MEMORY_TRUTH_SOURCE_CENSUS.map(({ id }) => id)).toEqual(MEMORY_SURFACE_IDS);
    for (const item of MEMORY_TRUTH_SOURCE_CENSUS) {
      const source = readFileSync(`${repositoryRoot}${item.path}`, "utf8");
      expect(source, item.path).toContain(item.token);
    }
  });
});
