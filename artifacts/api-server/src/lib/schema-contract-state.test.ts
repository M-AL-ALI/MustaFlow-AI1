import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

import {
  SCHEMA_CONTRACT_MAX_AGE_MS,
  SCHEMA_CONTRACT_QUERY_TIMEOUT_MS,
  ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT,
  ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY,
  SchemaContractMonitor,
  evaluateZeroPromptQueueSchemaContract,
  type ZeroPromptQueueSchemaCatalog,
} from "./schema-contract-state";

function validCatalog(): ZeroPromptQueueSchemaCatalog {
  return {
    tableExists: true,
    columns: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.columns.map(({ name, dataType, notNull }) => ({
      name,
      dataType,
      notNull,
    })),
    constraints: [
      {
        name: "zero_prompt_queue_items_pkey",
        type: "p",
        validated: true,
        deleteAction: " ",
        definition: "PRIMARY KEY (id)",
      },
      {
        name: "zero_prompt_queue_items_project_id_fkey",
        type: "f",
        validated: true,
        deleteAction: "c",
        definition: "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
      },
      {
        name: "zero_prompt_queue_items_position_check",
        type: "c",
        validated: true,
        deleteAction: " ",
        definition: "CHECK (position > 0)",
      },
      {
        name: "zero_prompt_queue_items_text_check",
        type: "c",
        validated: true,
        deleteAction: " ",
        definition: "CHECK (char_length(current_text) >= 1 AND char_length(current_text) <= 10000)",
      },
      {
        name: "zero_prompt_queue_items_state_check",
        type: "c",
        validated: true,
        deleteAction: " ",
        definition: "CHECK (state = ANY (ARRAY['queued', 'promoted', 'deleted']))",
      },
      {
        name: "zero_prompt_queue_items_terminal_check",
        type: "c",
        validated: true,
        deleteAction: " ",
        definition:
          "CHECK ((state = 'queued' AND promoted_turn_id IS NULL AND deleted_by IS NULL) OR (state = 'promoted' AND promoted_turn_id IS NOT NULL AND deleted_by IS NULL) OR (state = 'deleted' AND promoted_turn_id IS NULL AND deleted_by IS NOT NULL))",
      },
      {
        name: "zero_prompt_queue_items_project_position_unique",
        type: "u",
        validated: true,
        deleteAction: " ",
        definition: "UNIQUE (project_id, position)",
      },
    ],
    indexes: [
      {
        name: "zero_prompt_queue_items_pkey",
        tableName: "zero_prompt_queue_items",
        unique: true,
        valid: true,
        ready: true,
        definition:
          "CREATE UNIQUE INDEX zero_prompt_queue_items_pkey ON public.zero_prompt_queue_items USING btree (id)",
        predicate: "",
      },
      {
        name: "zero_prompt_queue_items_project_position_unique",
        tableName: "zero_prompt_queue_items",
        unique: true,
        valid: true,
        ready: true,
        definition:
          "CREATE UNIQUE INDEX zero_prompt_queue_items_project_position_unique ON public.zero_prompt_queue_items USING btree (project_id, position)",
        predicate: "",
      },
      {
        name: "zero_prompt_queue_items_project_state_idx",
        tableName: "zero_prompt_queue_items",
        unique: false,
        valid: true,
        ready: true,
        definition:
          "CREATE INDEX zero_prompt_queue_items_project_state_idx ON public.zero_prompt_queue_items USING btree (project_id, state, position)",
        predicate: "",
      },
      {
        name: "project_activity_queue_item_idx",
        tableName: "project_activity",
        unique: false,
        valid: true,
        ready: true,
        definition:
          "CREATE INDEX project_activity_queue_item_idx ON public.project_activity USING btree (project_id, ((metadata ->> 'itemId'::text)), created_at DESC)",
        predicate: "event_type ~~ 'queue.item.%'::text",
      },
    ],
  };
}

function evaluate(catalog: ZeroPromptQueueSchemaCatalog) {
  return evaluateZeroPromptQueueSchemaContract(catalog, 100, 3);
}

describe("zero prompt queue schema contract", () => {
  it("accepts the complete versioned catalog contract", () => {
    expect(evaluate(validCatalog())).toEqual({
      contractId: "zero_prompt_queue_v1",
      status: "ready",
      checkedAtMs: 100,
      durationMs: 3,
      violations: [],
    });
  });

  it.each([
    {
      name: "missing column",
      mutate(catalog: ZeroPromptQueueSchemaCatalog) {
        catalog.columns = catalog.columns.filter((column) => column.name !== "current_text");
      },
      violation: "column_missing",
    },
    {
      name: "wrong nullability",
      mutate(catalog: ZeroPromptQueueSchemaCatalog) {
        const column = catalog.columns.find(({ name }) => name === "project_id");
        if (column) column.notNull = false;
      },
      violation: "column_nullability_mismatch",
    },
    {
      name: "unvalidated constraint",
      mutate(catalog: ZeroPromptQueueSchemaCatalog) {
        const constraint = catalog.constraints.find(
          ({ name }) => name === "zero_prompt_queue_items_project_id_fkey",
        );
        if (constraint) constraint.validated = false;
      },
      violation: "constraint_unvalidated",
    },
    {
      name: "wrong foreign-key delete action",
      mutate(catalog: ZeroPromptQueueSchemaCatalog) {
        const constraint = catalog.constraints.find(
          ({ name }) => name === "zero_prompt_queue_items_project_id_fkey",
        );
        if (constraint) constraint.deleteAction = "a";
      },
      violation: "constraint_delete_action_mismatch",
    },
    {
      name: "index not ready",
      mutate(catalog: ZeroPromptQueueSchemaCatalog) {
        const index = catalog.indexes.find(
          ({ name }) => name === "zero_prompt_queue_items_project_state_idx",
        );
        if (index) index.ready = false;
      },
      violation: "index_not_ready",
    },
  ])("classifies $name as unready", ({ mutate, violation }) => {
    const catalog = validCatalog();
    mutate(catalog);
    const state = evaluate(catalog);
    expect(state.status).toBe("unready");
    expect(state.violations).toContain(violation);
  });

  it("uses one metadata-only catalog query and reads state without writes", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [validCatalog()] });
    const monitor = new SchemaContractMonitor();
    const ticks = [1_000, 1_007];

    await expect(
      monitor.verify(
        { query: query as unknown as PoolClient["query"] },
        () => ticks.shift() ?? 1_007,
      ),
    ).resolves.toMatchObject({ status: "ready", durationMs: 7 });
    expect(query).toHaveBeenCalledTimes(1);
    const [config] = query.mock.calls[0] as [{ text: string; query_timeout: number }];
    expect(config.text.trimStart().toUpperCase()).toMatch(/^SELECT\b/u);
    expect(config.text).toBe(ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY);
    expect(config.query_timeout).toBe(SCHEMA_CONTRACT_QUERY_TIMEOUT_MS);
    expect(config.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/iu);

    const beforeRead = monitor.read(1_007);
    const afterRead = monitor.read(1_007);
    expect(afterRead).toEqual(beforeRead);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails stale verification closed without mutating its stored successful check", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [validCatalog()] });
    const monitor = new SchemaContractMonitor();
    const ticks = [5_000, 5_001];
    await monitor.verify(
      { query: query as unknown as PoolClient["query"] },
      () => ticks.shift() ?? 5_001,
    );

    expect(monitor.read(5_001 + SCHEMA_CONTRACT_MAX_AGE_MS + 1)).toMatchObject({
      status: "unready",
      violations: ["verification_stale"],
    });
    expect(monitor.read(5_001)).toMatchObject({ status: "ready", violations: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("pins the migration output to every requirement in the same registry", async () => {
    const { applyZeroPromptQueuePersistenceMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyZeroPromptQueuePersistenceMigration>[0];

    await applyZeroPromptQueuePersistenceMigration(client);
    const migrationSql = statements.join("\n").toLowerCase();
    expect(migrationSql).toContain(
      ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.tableMigrationFragment.toLowerCase(),
    );
    for (const column of ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.columns) {
      expect(migrationSql, column.name).toContain(column.migrationFragment.toLowerCase());
    }
    for (const constraint of ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.constraints) {
      for (const fragment of constraint.migrationFragments) {
        expect(migrationSql, constraint.name).toContain(fragment.toLowerCase());
      }
    }
    for (const index of ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.indexes) {
      for (const fragment of index.migrationFragments) {
        expect(migrationSql, index.name).toContain(fragment.toLowerCase());
      }
    }
  });
});
