import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProductionDatabaseAdmissionSchema } from "./production-database-admission-schema";

const ambientPool = vi.hoisted(() => ({
  query: vi.fn(() => {
    throw new Error("unexpected_ambient_migration_pool_query");
  }),
  connect: vi.fn(() => {
    throw new Error("unexpected_ambient_migration_pool_connect");
  }),
}));
vi.mock("@workspace/db", () => ({ pool: ambientPool }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { applyProductionDatabaseAdmissionMigration } from "./startup-migrations";

async function schemaBatch() {
  const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
  await ensureProductionDatabaseAdmissionSchema({ query } as never);
  expect(query).toHaveBeenCalledTimes(1);
  return { query, sql: query.mock.calls[0]![0] };
}

describe("production database admission startup migration", () => {
  beforeEach(() => {
    ambientPool.query.mockClear();
    ambientPool.connect.mockClear();
  });

  it("bounds and commits the admission schema on the supplied migration client only", async () => {
    const query = vi.fn(async (_statement: string) => ({ rows: [], rowCount: 0 }));
    const client = { query };
    await applyProductionDatabaseAdmissionMigration(client as never);
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL statement_timeout = '30s'",
      expect.stringContaining(
        "CREATE TABLE IF NOT EXISTS public.production_database_admission_epochs",
      ),
      "COMMIT",
    ]);
    expect(query.mock.contexts.every((context) => context === client)).toBe(true);
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(ambientPool.query).not.toHaveBeenCalled();
    expect(ambientPool.connect).not.toHaveBeenCalled();
  });

  it.each([
    "BEGIN",
    "SET LOCAL lock_timeout = '5s'",
    "SET LOCAL statement_timeout = '30s'",
    "COMMIT",
  ])("rolls back and preserves a failure at %s", async (failedStatement) => {
    const original = new Error("fixture migration boundary failure");
    const query = vi.fn(async (statement: string) => {
      if (statement === failedStatement) throw original;
      return { rows: [], rowCount: 0 };
    });
    const client = { query };
    await expect(applyProductionDatabaseAdmissionMigration(client as never)).rejects.toBe(original);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(query.mock.contexts.every((context) => context === client)).toBe(true);
    if (failedStatement !== "COMMIT") {
      expect(query).not.toHaveBeenCalledWith("COMMIT");
      expect(query.mock.calls.some(([statement]) => statement.includes("CREATE TABLE"))).toBe(
        false,
      );
    }
    expect(ambientPool.query).not.toHaveBeenCalled();
    expect(ambientPool.connect).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves the schema error even if rollback also fails: %s",
    async (rollbackFails) => {
      const original = new Error("fixture schema failure");
      const rollbackError = new Error("fixture rollback failure");
      const query = vi.fn(async (statement: string) => {
        if (
          statement.includes(
            "CREATE TABLE IF NOT EXISTS public.production_database_admission_epochs",
          )
        ) {
          throw original;
        }
        if (statement === "ROLLBACK" && rollbackFails) throw rollbackError;
        return { rows: [], rowCount: 0 };
      });
      const client = { query };
      await expect(applyProductionDatabaseAdmissionMigration(client as never)).rejects.toBe(
        original,
      );
      expect(query.mock.calls.slice(0, 3).map(([statement]) => statement)).toEqual([
        "BEGIN",
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '30s'",
      ]);
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
      expect(query.mock.contexts.every((context) => context === client)).toBe(true);
      expect(ambientPool.query).not.toHaveBeenCalled();
      expect(ambientPool.connect).not.toHaveBeenCalled();
    },
  );

  it("registers exactly one additional step after purge and preview schema readiness", () => {
    const source = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const start = source.indexOf("const MIGRATION_STEPS");
    expect(start).toBeGreaterThan(-1);
    const steps = source.slice(start, source.indexOf("\n];", start));
    const names = [...steps.matchAll(/^\s{4}name: "([^"]+)",$/gmu)].map((match) => match[1]);
    expect(names).toHaveLength(158);
    expect(new Set(names).size).toBe(156);
    expect(names.slice(-2)).toEqual([
      "migrate-production-database-admission",
      "migrate-asset-product-scope-v1",
    ]);
    expect(names.filter((name) => name === "migrate-production-database-admission")).toHaveLength(
      1,
    );
    const admission = steps.indexOf('name: "migrate-production-database-admission"');
    const purge = steps.search(/await\s+applyProjectPurgeOperationsMigration\s*\(\s*client\s*\)/u);
    const preview = steps.search(
      /await\s+applyPreviewDatabaseAllocationMigration\s*\(\s*client\s*\)/u,
    );
    expect(purge).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(-1);
    expect(admission).toBeGreaterThan(purge);
    expect(admission).toBeGreaterThan(preview);
    const productScope = steps.indexOf('name: "migrate-asset-product-scope-v1"');
    expect(productScope).toBeGreaterThan(admission);
    const admissionStep = steps.slice(admission, productScope);
    expect(admissionStep).toMatch(
      /async run\(client\)\s*\{\s*await applyProductionDatabaseAdmissionMigration\(client\);/u,
    );
    expect(admissionStep).not.toMatch(/\bpool\b/u);
    expect(steps.slice(productScope)).toMatch(
      /async run\(client\)\s*\{\s*await applyUnifiedAssetRegistryMigration\(client\);/u,
    );
  });

  it("submits one additive idempotent batch per invocation with no table drops", async () => {
    const { query, sql } = await schemaBatch();
    await ensureProductionDatabaseAdmissionSchema({ query } as never);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toBe(sql);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/gu)).toHaveLength(2);
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM pg_trigger");
    expect(
      sql.match(/CREATE OR REPLACE TRIGGER production_database_project_birth\b/gu),
    ).toHaveLength(1);
    expect(sql).not.toMatch(/\btgname\s*=\s*'production_database_project_birth'/u);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b|\bTRUNCATE\b/iu);
  });

  it("never creates or activates an epoch and never backfills historical projects", async () => {
    const { sql } = await schemaBatch();
    expect(sql).toContain("state text NOT NULL DEFAULT 'prepared'");
    expect(sql).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?production_database_admission_epochs\b/iu,
    );
    expect(sql).not.toMatch(/\bFROM\s+(?:public\.)?projects\b/iu);
    expect(sql).not.toMatch(/\bUPDATE\s+(?:public\.)?projects\b/iu);
    const birth = /AS \$birth\$([\s\S]*?)\$birth\$/u.exec(sql)?.[1] ?? "";
    expect(birth).toMatch(/IF NOT FOUND THEN[\s\S]*?RETURN NEW;[\s\S]*?END IF;/u);
    expect(birth.indexOf("RETURN NEW;")).toBeLessThan(
      birth.indexOf("INSERT INTO public.production_database_admission_receipts"),
    );
  });

  it("requires activation to have taken effect before selecting a birth epoch", async () => {
    const { sql } = await schemaBatch();
    const birth = /AS \$birth\$([\s\S]*?)\$birth\$/u.exec(sql)?.[1] ?? "";
    const activeSelect =
      /SELECT\s+\*\s+INTO\s+active_epoch\s+FROM\s+public\.production_database_admission_epochs\s+WHERE([\s\S]*?)FOR\s+SHARE\s*;/iu.exec(
        birth,
      )?.[1] ?? "";
    expect(activeSelect).toMatch(/\bstate\s*=\s*'active'/iu);
    expect(activeSelect).toMatch(/\bAND\s+activated_at\s*<=\s*clock_timestamp\(\)/iu);
  });

  it("registers birth transactionally through the projects row trigger for every creator", async () => {
    const { sql } = await schemaBatch();
    expect(sql).toMatch(
      /CREATE OR REPLACE TRIGGER production_database_project_birth BEFORE INSERT ON public\.projects\s+FOR EACH ROW EXECUTE FUNCTION public\.register_production_database_project_birth\(\)/u,
    );
    const birth = /AS \$birth\$([\s\S]*?)\$birth\$/u.exec(sql)?.[1] ?? "";
    expect(birth).toContain("FOR SHARE");
    expect(birth).toContain("currval(sequence_name::regclass)");
    expect(birth).toContain("IF generated_id IS DISTINCT FROM NEW.id THEN");
    expect(birth).toContain("NEW.id <= active_epoch.project_id_floor");
    expect(birth).toContain("production_database_project_identity_reused");
    expect(birth).toMatch(
      /INSERT INTO public\.production_database_admission_receipts[\s\S]*?VALUES \(NEW\.id, active_epoch\.epoch, gen_random_uuid\(\), true, 'fresh'\)/u,
    );
    expect(sql).not.toMatch(/\bfetch\s*\(|https?:\/\/|\bensureHTTP\b/iu);
  });

  it("retains minimal receipts with only an epoch FK, never a project FK", async () => {
    const { sql } = await schemaBatch();
    expect(sql).toContain("project_id integer PRIMARY KEY");
    expect(sql.match(/\bREFERENCES\b/gu)).toHaveLength(1);
    expect(sql).toContain(
      "registration_epoch uuid NOT NULL REFERENCES public.production_database_admission_epochs(epoch)",
    );
    expect(sql).not.toMatch(/REFERENCES\s+(?:public\.)?projects\b|ON DELETE CASCADE/iu);
    expect(sql).toMatch(
      /CREATE TRIGGER production_database_admission_receipt_guard\s+BEFORE UPDATE OR DELETE ON public\.production_database_admission_receipts\s+FOR EACH ROW/u,
    );
    expect(sql).toContain("production_database_admission_receipt_retained");
    expect(sql).toContain("production_database_admission_receipt_immutable");
    expect(sql).toContain("OLD.state = 'sealed' AND NEW IS DISTINCT FROM OLD");
  });
});
