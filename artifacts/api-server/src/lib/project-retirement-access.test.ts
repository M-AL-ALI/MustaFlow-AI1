import { describe, expect, it } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  canvasAbTestsTable,
  canvasVariantsTable,
  previewSessionsTable,
  shareLinksTable,
  supportAccessGrantsTable,
  supportGrantEventsTable,
  supportZeroSessionsTable,
} from "@workspace/db/schema";
import { initialProjectRetirementProgress } from "./project-retirement-contract";
import {
  PROJECT_RETIREMENT_NONTERMINAL_SUPPORT_SESSION_STATUSES,
  PROJECT_RETIREMENT_NONTERMINAL_CANVAS_AB_TEST_STATUSES,
  PROJECT_RETIREMENT_OPEN_GRANT_STATUSES,
  retireProjectAccessSurfaces,
} from "./project-retirement-access";

type UpdateCall = {
  table: unknown;
  values: Record<string, unknown>;
  predicate: SQL;
};

function fakeTransaction(returnedRows: Map<unknown, Array<Record<string, unknown>>>) {
  const updates: UpdateCall[] = [];
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(predicate: SQL) {
              updates.push({ table, values, predicate });
              return {
                returning: async () => returnedRows.get(table) ?? [],
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (values: unknown) => {
          inserts.push({ table, values });
        },
      };
    },
  };
  return { tx, updates, inserts };
}

function renderedPredicate(predicate: SQL): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(predicate);
  return { sql: query.sql.replace(/\s+/gu, " ").trim(), params: query.params };
}

describe("project retirement access revocation", () => {
  it("uses the closed open-grant and nonterminal-session status sets", () => {
    expect(PROJECT_RETIREMENT_OPEN_GRANT_STATUSES).toEqual(["pending", "active"]);
    expect(PROJECT_RETIREMENT_NONTERMINAL_SUPPORT_SESSION_STATUSES).toEqual([
      "diagnosing",
      "proposal_ready",
      "approved",
      "applying",
    ]);
    expect(PROJECT_RETIREMENT_NONTERMINAL_CANVAS_AB_TEST_STATUSES).toEqual(["running", "paused"]);
  });

  it("revokes only live project-bound access and returns an exact receipt", async () => {
    const returnedRows = new Map<unknown, Array<Record<string, unknown>>>([
      [shareLinksTable, [{ id: 11 }, { id: 12 }]],
      [previewSessionsTable, [{ id: 21 }]],
      [
        supportAccessGrantsTable,
        [
          { id: 31, ticketId: 301 },
          { id: 32, ticketId: 302 },
        ],
      ],
      [supportZeroSessionsTable, [{ id: 41 }]],
      [canvasVariantsTable, [{ id: 51 }, { id: 52 }, { id: 53 }]],
      [canvasAbTestsTable, [{ id: 61 }, { id: 62 }]],
    ]);
    const harness = fakeTransaction(returnedRows);
    const progress = await retireProjectAccessSurfaces(harness.tx as never, {
      projectId: 7,
      actorUserId: "user_retirement_worker",
      progress: initialProjectRetirementProgress(),
    });

    expect(progress.access).toEqual({
      state: "revoked",
      shareLinksRevoked: 2,
      previewSessionsRevoked: 1,
      supportGrantsRevoked: 2,
      supportSessionsInterrupted: 1,
      canvasShareTokensCleared: 3,
      canvasAbTestsEnded: 2,
    });
    expect(harness.updates.map((call) => call.table)).toEqual([
      shareLinksTable,
      previewSessionsTable,
      supportAccessGrantsTable,
      supportZeroSessionsTable,
      canvasVariantsTable,
      canvasAbTestsTable,
    ]);

    const [
      sharePredicate,
      previewPredicate,
      grantPredicate,
      sessionPredicate,
      canvasSharePredicate,
      canvasAbPredicate,
    ] = harness.updates.map((call) => renderedPredicate(call.predicate));
    expect(sharePredicate.sql).toContain('"share_links"."project_id" = $1');
    expect(sharePredicate.sql).toContain('"share_links"."revoked" = $2');
    expect(sharePredicate.params).toEqual([7, false]);
    expect(previewPredicate.sql).toContain('"preview_sessions"."project_id" = $1');
    expect(previewPredicate.sql).toContain('"preview_sessions"."revoked_at" is null');
    expect(previewPredicate.params).toEqual([7]);
    expect(grantPredicate.sql).toContain('"support_access_grants"."project_id" = $1');
    expect(grantPredicate.sql).toContain('"support_access_grants"."status" in ($2, $3)');
    expect(grantPredicate.params).toEqual([7, "pending", "active"]);
    expect(sessionPredicate.sql).toContain('"support_zero_sessions"."project_id" = $1');
    expect(sessionPredicate.sql).toContain('"support_zero_sessions"."status" in ($2, $3, $4, $5)');
    expect(sessionPredicate.params).toEqual([
      7,
      "diagnosing",
      "proposal_ready",
      "approved",
      "applying",
    ]);
    expect(canvasSharePredicate.sql).toContain('"canvas_variants"."project_id" = $1');
    expect(canvasSharePredicate.sql).toContain('"canvas_variants"."share_token" is not null');
    expect(canvasSharePredicate.params).toEqual([7]);
    expect(canvasAbPredicate.sql).toContain('"canvas_ab_tests"."project_id" = $1');
    expect(canvasAbPredicate.sql).toContain('"canvas_ab_tests"."status" in ($2, $3)');
    expect(canvasAbPredicate.params).toEqual([7, "running", "paused"]);
  });

  it("uses the database clock and writes one sanitized provenance event per revoked grant", async () => {
    const harness = fakeTransaction(
      new Map<unknown, Array<Record<string, unknown>>>([
        [shareLinksTable, [{ id: 1 }]],
        [previewSessionsTable, [{ id: 2 }]],
        [supportAccessGrantsTable, [{ id: 3, ticketId: 30 }]],
        [supportZeroSessionsTable, [{ id: 4 }]],
        [canvasVariantsTable, [{ id: 5 }]],
        [canvasAbTestsTable, [{ id: 6 }]],
      ]),
    );
    await retireProjectAccessSurfaces(harness.tx as never, {
      projectId: 9,
      actorUserId: "user_retirement_worker",
      progress: initialProjectRetirementProgress(),
    });

    const shareUpdate = harness.updates.find((call) => call.table === shareLinksTable)!;
    const previewUpdate = harness.updates.find((call) => call.table === previewSessionsTable)!;
    const grantUpdate = harness.updates.find((call) => call.table === supportAccessGrantsTable)!;
    const sessionUpdate = harness.updates.find((call) => call.table === supportZeroSessionsTable)!;
    const canvasShareUpdate = harness.updates.find((call) => call.table === canvasVariantsTable)!;
    const canvasAbUpdate = harness.updates.find((call) => call.table === canvasAbTestsTable)!;
    expect(shareUpdate.values.revokedAt).toBeInstanceOf(SQL);
    expect(previewUpdate.values.revokedAt).toBeInstanceOf(SQL);
    expect(grantUpdate.values.decidedAt).toBeInstanceOf(SQL);
    expect(grantUpdate.values.revokedAt).toBeInstanceOf(SQL);
    expect(grantUpdate.values.closedAt).toBeInstanceOf(SQL);
    expect(sessionUpdate.values.completedAt).toBeInstanceOf(SQL);
    expect(canvasShareUpdate.values.shareToken).toBeNull();
    expect(canvasShareUpdate.values.updatedAt).toBeInstanceOf(SQL);
    expect(canvasAbUpdate.values.status).toBe("ended");
    expect(canvasAbUpdate.values.endedAt).toBeInstanceOf(SQL);
    expect(sessionUpdate.values.terminal).toEqual({
      contract: "support-zero-session-terminal-v1",
      outcome: "interrupted",
      code: "project_trashed",
      retryable: false,
    });

    expect(harness.inserts).toEqual([
      {
        table: supportGrantEventsTable,
        values: [
          {
            grantId: 3,
            ticketId: 30,
            projectId: 9,
            actorUserId: "user_retirement_worker",
            actorDisplayName: null,
            event: "access_revoked_project_trashed",
            detail: { reason: "project_trashed" },
          },
        ],
      },
    ]);
    const serializedWrites = JSON.stringify({
      inserts: harness.inserts.map((insert) => insert.values),
      terminal: sessionUpdate.values.terminal,
    });
    expect(serializedWrites).not.toMatch(/body|secret|token|proposal|evidenceBundle/iu);
  });

  it("emits no duplicate provenance when a replay finds no live rows", async () => {
    const harness = fakeTransaction(new Map());
    const progress = await retireProjectAccessSurfaces(harness.tx as never, {
      projectId: 12,
      actorUserId: "user_retirement_worker",
      progress: initialProjectRetirementProgress(),
    });

    expect(harness.inserts).toEqual([]);
    expect(progress.access).toEqual({
      state: "revoked",
      shareLinksRevoked: 0,
      previewSessionsRevoked: 0,
      supportGrantsRevoked: 0,
      supportSessionsInterrupted: 0,
      canvasShareTokensCleared: 0,
      canvasAbTestsEnded: 0,
    });
  });
});
