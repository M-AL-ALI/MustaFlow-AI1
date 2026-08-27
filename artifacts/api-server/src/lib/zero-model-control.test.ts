import { describe, expect, it } from "vitest";
import type { QueryResult } from "pg";
import {
  createZeroModelCallIdentity,
  ZeroModelIdentityError,
  type ZeroModelIdentityInput,
} from "./zero-model-control";
import {
  beginZeroModelCallReceipt,
  finishZeroModelCallReceipt,
  readActiveZeroModelBinding,
  type ZeroModelQueryExecutor,
} from "./zero-model-control-store";

const validIdentity: ZeroModelIdentityInput = {
  callId: "256718bf-b8bf-4a2b-9ab3-4eb5038b29ca",
  operationId: "task:51",
  taskId: 51,
  tier: "power",
  stage: "build",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  bindingVersionId: 7,
};

function result<Row extends Record<string, unknown>>(rows: Row[]): QueryResult<Row> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe("zero model identity", () => {
  it("keeps provider, model, tier, and stage as independent fields", () => {
    const identity = createZeroModelCallIdentity(validIdentity);
    expect(identity).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      tier: "power",
      stage: "build",
    });
  });

  it.each([
    ["provider", { provider: "anthropic:claude-sonnet-4-6" }],
    ["model", { model: "anthropic claude" }],
    ["tier", { tier: "build" }],
    ["operation", { operationId: "" }],
  ])("rejects an invalid %s field without deriving a replacement", (_name, override) => {
    expect(() =>
      createZeroModelCallIdentity({
        ...validIdentity,
        ...override,
      } as ZeroModelIdentityInput),
    ).toThrow(ZeroModelIdentityError);
  });
});

describe("zero model registry store", () => {
  it("reads the active version without issuing a write", async () => {
    const statements: string[] = [];
    const executor: ZeroModelQueryExecutor = {
      async query<Row extends Record<string, unknown>>(text: string) {
        statements.push(text);
        return result([
          {
            id: 7,
            tier: "power",
            version: 3,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            parameters: { temperature: 0 },
            state: "active",
          },
        ] as unknown as Row[]);
      },
    };

    await expect(readActiveZeroModelBinding(executor, "power")).resolves.toMatchObject({
      id: 7,
      version: 3,
      tier: "power",
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.trimStart().startsWith("SELECT")).toBe(true);
  });

  it("writes the three identity fields separately before dispatch and terminals once", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const executor: ZeroModelQueryExecutor = {
      async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        return result([] as Row[]);
      },
    };

    const identity = await beginZeroModelCallReceipt(executor, validIdentity);
    await finishZeroModelCallReceipt(executor, identity.callId, {
      status: "completed",
      inputTokens: 120,
      outputTokens: 42,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.values?.slice(3, 7)).toEqual([
      "power",
      "build",
      "anthropic",
      "claude-sonnet-4-6",
    ]);
    expect(calls[1]?.text).toContain("WHERE id = $1 AND status = 'started'");
  });
});
