import { describe, expect, it } from "vitest";
import { buildMemoryTruthRecord, type MemoryTruthRecordInput } from "./memory-truth";
import {
  assertMemoryReconciliationResult,
  MEMORY_RECONCILIATION_CHECK_IDS,
  MemoryReconciliationContractError,
  reconcileMemoryRecord,
  reconcileMemoryRecords,
  summarizeProjectMemoryReconciliation,
  type MemoryReconciliationCheck,
  type MemoryReconciliationReason,
  type MemoryReconciliationVerdict,
} from "./memory-reconciliation";

const observedAt = "2026-08-19T21:21:40.000Z";

function digest(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

function record(overrides: Partial<MemoryTruthRecordInput> = {}) {
  return buildMemoryTruthRecord({
    surfaceId: "knowledge-entries",
    recordId: 41,
    projectId: 52,
    scope: "project",
    versionId: 158,
    ...overrides,
  });
}

function checks(
  overrides: Partial<
    Record<(typeof MEMORY_RECONCILIATION_CHECK_IDS)[number], MemoryReconciliationCheck["outcome"]>
  > = {},
): readonly MemoryReconciliationCheck[] {
  const merged = new Map<
    MemoryReconciliationCheck["identity"],
    MemoryReconciliationCheck["outcome"]
  >();
  const defaults: readonly MemoryReconciliationCheck[] = [
    { identity: "observation-available", outcome: "confirmed" },
    { identity: "record-exists", outcome: "confirmed" },
    { identity: "project-binding", outcome: "confirmed" },
    { identity: "source-exists", outcome: "confirmed" },
    { identity: "source-project-binding", outcome: "confirmed" },
    { identity: "version-binding", outcome: "confirmed" },
    { identity: "provenance-complete", outcome: "confirmed" },
  ];
  for (const { identity, outcome } of defaults) merged.set(identity, outcome);
  for (const identity of MEMORY_RECONCILIATION_CHECK_IDS) {
    const outcome = overrides[identity];
    if (outcome) merged.set(identity, outcome);
  }
  return [...merged].map(([identity, outcome]) => ({ identity, outcome }));
}

function reconcile(
  overrideChecks: Parameters<typeof checks>[0] = {},
  recordOverrides: Partial<MemoryTruthRecordInput> = {},
) {
  return reconcileMemoryRecord(record(recordOverrides), {
    observationIdentitySha256: digest(`a${JSON.stringify(overrideChecks).length}`),
    observedAt,
    checks: checks(overrideChecks),
  });
}

describe("Zero memory reconciliation decision engine", () => {
  it.each<
    [
      string,
      Parameters<typeof checks>[0],
      Partial<MemoryTruthRecordInput>,
      MemoryReconciliationVerdict,
      MemoryReconciliationReason,
    ]
  >([
    ["binding confirmation", {}, {}, "confirmed", "authoritative_binding_confirmed"],
    [
      "content confirmation",
      { "content-hash": "confirmed" },
      {},
      "confirmed",
      "content_hash_confirmed",
    ],
    [
      "content contradiction",
      { "content-hash": "contradicted" },
      {},
      "stale",
      "content_hash_mismatch",
    ],
    [
      "current version advancement",
      { "current-project-version": "contradicted" },
      {},
      "stale",
      "current_project_version_advanced",
    ],
    [
      "source project contradiction",
      { "source-project-binding": "contradicted" },
      {},
      "stale",
      "source_project_mismatch",
    ],
    [
      "binding contradiction",
      { "version-binding": "contradicted" },
      {},
      "stale",
      "binding_contradicted",
    ],
    ["missing record", { "record-exists": "missing" }, {}, "unverifiable", "record_missing"],
    ["missing source", { "source-exists": "missing" }, {}, "unverifiable", "source_missing"],
    [
      "incomplete provenance",
      { "provenance-complete": "missing" },
      {},
      "unverifiable",
      "provenance_incomplete",
    ],
    [
      "missing version binding",
      { "version-binding": "missing" },
      {},
      "unverifiable",
      "version_binding_missing",
    ],
    [
      "semantic claim",
      { "semantic-verification": "unsupported" },
      {},
      "unverifiable",
      "semantic_claim_not_machine_verifiable",
    ],
    [
      "non-project scope",
      {},
      { scope: "user", projectId: null },
      "unverifiable",
      "non_project_scope_not_supported",
    ],
    [
      "observation outage",
      { "observation-available": "unavailable" },
      {},
      "unverifiable",
      "observation_unavailable",
    ],
  ])("classifies %s", (_label, overrideChecks, recordOverrides, verdict, reason) => {
    expect(reconcile(overrideChecks, recordOverrides)).toMatchObject({ verdict, reason });
  });

  it("keeps missing source evidence unverifiable even when the source was deleted", () => {
    expect(reconcile({ "source-exists": "missing" })).toMatchObject({
      verdict: "unverifiable",
      reason: "source_missing",
    });
  });

  it("keeps exact historical versions confirmed and never conflates rollback identities", () => {
    const version158 = reconcile({}, { recordId: 8, versionId: 158 });
    const version159 = reconcile({}, { recordId: 8, versionId: 159 });
    expect(version158.verdict).toBe("confirmed");
    expect(version159.verdict).toBe("confirmed");
    expect(version159.memoryRecordIdentitySha256).not.toBe(version158.memoryRecordIdentitySha256);
    expect(version159.evidenceIdentitySha256).not.toBe(version158.evidenceIdentitySha256);
  });

  it("pins evidence identity determinism across check and input ordering", () => {
    const first = {
      record: record({ recordId: 1 }),
      observation: {
        observationIdentitySha256: digest("a"),
        observedAt,
        checks: checks({ "content-hash": "confirmed" }),
      },
    };
    const second = {
      record: record({ recordId: 2 }),
      observation: {
        observationIdentitySha256: digest("b"),
        observedAt,
        checks: [...checks()].reverse(),
      },
    };
    const forward = reconcileMemoryRecords([first, second]);
    const reverse = reconcileMemoryRecords([
      {
        ...second,
        observation: { ...second.observation, checks: [...second.observation.checks].reverse() },
      },
      {
        ...first,
        observation: { ...first.observation, checks: [...first.observation.checks].reverse() },
      },
    ]);
    expect(reverse).toEqual(forward);
    expect(forward.map(({ evidenceIdentitySha256 }) => evidenceIdentitySha256)).toEqual(
      reverse.map(({ evidenceIdentitySha256 }) => evidenceIdentitySha256),
    );
  });

  it("fails typed and closed for malformed, duplicate, unknown, and impossible contracts", () => {
    expect(() =>
      reconcileMemoryRecord(record(), {
        observationIdentitySha256: "raw-row-id",
        observedAt,
        checks: checks(),
      }),
    ).toThrowError(MemoryReconciliationContractError);
    expect(() =>
      reconcileMemoryRecord(record(), {
        observationIdentitySha256: digest("a"),
        observedAt,
        checks: [
          { identity: "observation-available", outcome: "confirmed" },
          { identity: "record-exists", outcome: "unsafe" as never },
        ],
      }),
    ).toThrow("contains an invalid check");
    expect(() =>
      reconcileMemoryRecords([
        {
          record: record({ recordId: 1 }),
          observation: { observationIdentitySha256: digest("d"), observedAt, checks: checks() },
        },
        {
          record: record({ recordId: 2 }),
          observation: { observationIdentitySha256: digest("d"), observedAt, checks: checks() },
        },
      ]),
    ).toThrow("observation identity is duplicated");
    expect(() =>
      reconcileMemoryRecord(
        { ...record(), surfaceId: "unknown" as never },
        {
          observationIdentitySha256: digest("u"),
          observedAt,
          checks: checks(),
        },
      ),
    ).toThrow("Unknown memory reconciliation surface");
    expect(() =>
      assertMemoryReconciliationResult({
        ...reconcile(),
        verdict: "confirmed",
        reason: "record_missing",
      }),
    ).toThrow("is invalid for confirmed");
  });

  it("returns only sanitized closed fields and never returns secret-bearing input", () => {
    const hostile = {
      record: record(),
      observation: {
        observationIdentitySha256: digest("e"),
        observedAt,
        checks: checks({ "content-hash": "confirmed" }),
        body: "private body",
        prompt: "private prompt",
        summary: "private summary",
        plan: "private plan",
        credential: "private credential",
        url: "https://private.invalid",
        sql: "select private",
        rawError: "private transport",
      },
    };
    const json = JSON.stringify(reconcileMemoryRecord(hostile.record, hostile.observation));
    for (const forbidden of [
      "private body",
      "private prompt",
      "private summary",
      "private plan",
      "private credential",
      "private.invalid",
      "select private",
      "private transport",
      "projectId",
      "userId",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("summarizes reconciliation without exposing record identities or checks", () => {
    const results = [
      reconcile({}, { surfaceId: "project-summary", recordId: 1 }),
      reconcile(
        { "content-hash": "contradicted" },
        { surfaceId: "conversation-summaries", recordId: 2 },
      ),
      reconcile({ "source-exists": "missing" }, { surfaceId: "knowledge-entries", recordId: 3 }),
    ];

    const summary = summarizeProjectMemoryReconciliation(results);
    expect(summary).toEqual({
      semantics: "zero-project-memory-reconciliation-summary-v2",
      status: "review-needed",
      observedAt,
      counts: { confirmed: 1, stale: 1, unverifiable: 1 },
      coverage: { complete: true, rowLimit: null, limitedSurfaces: [] },
      surfaces: [
        {
          surfaceId: "conversation-summaries",
          status: "review-needed",
          confirmed: 0,
          stale: 1,
          unverifiable: 0,
        },
        {
          surfaceId: "knowledge-entries",
          status: "limited",
          confirmed: 0,
          stale: 0,
          unverifiable: 1,
        },
        {
          surfaceId: "project-summary",
          status: "current",
          confirmed: 1,
          stale: 0,
          unverifiable: 0,
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(/memoryRecord|evidenceIdentity|checks|projectId/);
  });

  it("reports an honest empty state when the project has no saved memory", () => {
    expect(summarizeProjectMemoryReconciliation([])).toEqual({
      semantics: "zero-project-memory-reconciliation-summary-v2",
      status: "empty",
      observedAt: null,
      counts: { confirmed: 0, stale: 0, unverifiable: 0 },
      coverage: { complete: true, rowLimit: null, limitedSurfaces: [] },
      surfaces: [],
    });
  });

  it("fails closed when a bounded reader cannot cover every memory row", () => {
    const summary = summarizeProjectMemoryReconciliation(
      [reconcile({}, { surfaceId: "project-summary", recordId: 1 })],
      { limitedSurfaces: ["chat-messages", "project-summary"], rowLimit: 500 },
    );

    expect(summary.status).toBe("limited");
    expect(summary.coverage).toEqual({
      complete: false,
      rowLimit: 500,
      limitedSurfaces: ["chat-messages", "project-summary"],
    });
    expect(summary.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surfaceId: "chat-messages", status: "limited" }),
        expect.objectContaining({ surfaceId: "project-summary", status: "limited" }),
      ]),
    );
  });
});
