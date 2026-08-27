import { describe, expect, it } from "vitest";
import {
  ZERO_TERMINAL_UNKNOWN,
  changedWithIssuesTerminal,
  failedTerminal,
  interruptedTerminal,
  mutationSucceededTerminal,
  parseZeroTerminalV1,
  planSucceededTerminal,
  presentZeroTerminalV1,
  responseSucceededTerminal,
} from "@workspace/ora-contracts";
const common = {
  schema: "zero-terminal-v1",
  taskId: 41,
  intent: "mutate",
  intentReceiptId: 91,
  completedAt: "2026-08-22T12:00:00.000Z",
} as const;

const readyPreview = {
  promised: true,
  state: "ready",
  receiptId: "preview:41:3",
} as const;

describe("ZeroTerminalV1", () => {
  it("makes success construction require its durable evidence", () => {
    function _terminalEvidenceIsRequired(): void {
      // @ts-expect-error mutation success cannot exist without version/diff/preview evidence
      mutationSucceededTerminal({
        ...common,
        outcome: "mutation_succeeded",
        runStatus: "completed",
      });
      // @ts-expect-error changed-with-issues cannot exist without the mutation receipt
      changedWithIssuesTerminal({
        ...common,
        outcome: "changed_with_issues",
        runStatus: "completed",
        cause: { code: "preview_failed", stage: "preview" },
      });
      // @ts-expect-error response success cannot exist without the persisted assistant message
      responseSucceededTerminal({
        ...common,
        outcome: "response_succeeded",
        runStatus: "completed",
      });
      responseSucceededTerminal({
        ...common,
        outcome: "response_succeeded",
        runStatus: "completed",
        // @ts-expect-error a saved message alone cannot prove the provider completed the response
        evidence: { assistantMessageId: 44 },
      });
      // @ts-expect-error plan success cannot exist without both message and plan references
      planSucceededTerminal({ ...common, outcome: "plan_succeeded", runStatus: "completed" });
      // @ts-expect-error the presenter never accepts display strings as terminal truth
      presentZeroTerminalV1("completed");
    }
    void _terminalEvidenceIsRequired;
    expect(true).toBe(true);
  });

  it("parses valid durable JSON and refuses missing or malformed success as UNKNOWN", () => {
    const terminal = mutationSucceededTerminal({
      ...common,
      outcome: "mutation_succeeded",
      runStatus: "completed",
      evidence: {
        versionId: 7,
        diffRef: { kind: "task_report", taskId: 41, revision: 1 },
        preview: readyPreview,
      },
    });
    expect(parseZeroTerminalV1(JSON.parse(JSON.stringify(terminal)))).toMatchObject({
      outcome: "mutation_succeeded",
      evidence: { versionId: 7, preview: { state: "ready" } },
    });
    expect(parseZeroTerminalV1(null)).toBe(ZERO_TERMINAL_UNKNOWN);
    expect(parseZeroTerminalV1({ ...terminal, evidence: { preview: readyPreview } })).toBe(
      ZERO_TERMINAL_UNKNOWN,
    );
    expect(parseZeroTerminalV1({ ...terminal, schema: "zero-terminal-v0" })).toBe(
      ZERO_TERMINAL_UNKNOWN,
    );
    expect(
      parseZeroTerminalV1({
        ...common,
        intent: "answer",
        outcome: "response_succeeded",
        runStatus: "completed",
        evidence: { assistantMessageId: 44 },
      }),
    ).toBe(ZERO_TERMINAL_UNKNOWN);
  });

  it("presents all six variants from evidence rather than legacy status prose", () => {
    const mutation = mutationSucceededTerminal({
      ...common,
      outcome: "mutation_succeeded",
      runStatus: "completed",
      evidence: {
        versionId: 7,
        diffRef: { kind: "task_report", taskId: 41, revision: 1 },
        preview: readyPreview,
      },
    });
    const response = responseSucceededTerminal({
      ...common,
      intent: "answer",
      outcome: "response_succeeded",
      runStatus: "completed",
      evidence: {
        assistantMessageId: 44,
        stopEvidence: { providerReason: "stop" },
      },
    });
    const plan = planSucceededTerminal({
      ...common,
      intent: "plan",
      outcome: "plan_succeeded",
      runStatus: "completed",
      evidence: {
        assistantMessageId: 45,
        planRef: { kind: "chat_message_plan", messageId: 45 },
      },
    });
    const issues = changedWithIssuesTerminal({
      ...common,
      outcome: "changed_with_issues",
      runStatus: "completed",
      cause: { code: "validation_failed", stage: "checks" },
      evidence: {
        versionId: 7,
        diffRef: { kind: "task_report", taskId: 41, revision: 1 },
        preview: { promised: true, state: "unavailable", cause: "runtime_unavailable" },
      },
    });
    const interrupted = interruptedTerminal({
      ...common,
      outcome: "interrupted",
      runStatus: "interrupted",
      cause: "user_stop",
      evidence: { lastPhase: "between_steps", changedPaths: ["src/App.tsx"] },
    });
    const failed = failedTerminal({
      ...common,
      outcome: "failed",
      runStatus: "failed",
      cause: { code: "checks_failed", stage: "validation" },
      evidence: { summary: "Required checks did not pass." },
    });

    expect(presentZeroTerminalV1(mutation)).toMatchObject({
      tone: "success",
      taskStatus: "completed",
      shouldRefreshPreview: true,
    });
    expect(presentZeroTerminalV1(response).message).toBe("Response sent.");
    expect(presentZeroTerminalV1(plan).message).toBe("Plan ready.");
    expect(presentZeroTerminalV1(issues).message).toBe(
      "Changes were saved, but validation failed during checks. Preview is unavailable: runtime unavailable.",
    );
    expect(presentZeroTerminalV1(interrupted).message).toBe("This run was interrupted.");
    const truncated = interruptedTerminal({
      ...common,
      outcome: "interrupted",
      runStatus: "interrupted",
      cause: "completion_truncated",
      evidence: { lastPhase: "response_stream", changedPaths: [] },
    });
    expect(presentZeroTerminalV1(truncated)).toMatchObject({
      tone: "interrupted",
      title: "Response ended early",
      message: "Zero's response was cut short. Please try again.",
    });
    expect(presentZeroTerminalV1(failed).message).toBe("Required checks did not pass.");
    expect(presentZeroTerminalV1(ZERO_TERMINAL_UNKNOWN).message).toBe(
      "Outcome unavailable for this older run",
    );
  });

  it("accepts honest local clarification evidence without inventing a provider stop", () => {
    const terminal = responseSucceededTerminal({
      ...common,
      intent: "clarify",
      outcome: "response_succeeded",
      runStatus: "completed",
      evidence: {
        assistantMessageId: 44,
        stopEvidence: {
          source: "local_contract_fallback",
          fallbackCode: "clarification_provider_unavailable",
        },
      },
    });

    expect(parseZeroTerminalV1(terminal)).toMatchObject({
      evidence: {
        stopEvidence: {
          source: "local_contract_fallback",
          fallbackCode: "clarification_provider_unavailable",
        },
      },
    });
  });
});

describe("migration 145 terminal column", () => {
  it("is idempotent and verifies the nullable JSONB column without real DDL", async () => {
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";
    const { applyZeroTerminalMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        return statement.includes("information_schema.columns")
          ? { rows: [{ terminal_ready: true }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyZeroTerminalMigration>[0];

    await applyZeroTerminalMigration(client);
    const first = [...statements];
    statements.length = 0;
    await applyZeroTerminalMigration(client);
    expect(statements).toEqual(first);
    expect(first[0]).toBe("ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS terminal JSONB");
    expect(first.join("\n")).not.toMatch(/\b(DROP|TRUNCATE|UPDATE|DELETE)\b/i);
  });
});
