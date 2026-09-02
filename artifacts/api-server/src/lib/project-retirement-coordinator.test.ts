import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const canonicalRetirementColumns = [
  ["id", "text", "NO", null],
  ["project_id", "integer", "NO", null],
  ["requested_by", "text", "NO", null],
  ["state", "text", "NO", "'accepted'::text"],
  ["attempt_count", "integer", "NO", "0"],
  ["lease_version", "integer", "NO", "0"],
  ["lease_expires_at", "timestamp with time zone", "YES", null],
  ["progress", "jsonb", "NO", null],
  ["failure_code", "text", "YES", null],
  ["failure_target", "jsonb", "YES", null],
  ["created_at", "timestamp with time zone", "NO", "now()"],
  ["started_at", "timestamp with time zone", "YES", null],
  ["completed_at", "timestamp with time zone", "YES", null],
  ["updated_at", "timestamp with time zone", "NO", "now()"],
].map(([column_name, data_type, is_nullable, column_default]) => ({
  column_name,
  data_type,
  is_nullable,
  column_default,
}));

const canonicalRetirementConstraints = [
  ["project_retirement_operations_pkey", "p", "PRIMARY KEY (id)"],
  [
    "project_retirement_operations_state_check",
    "c",
    "CHECK (state IN ('accepted','running','failed','completed','canceled'))",
  ],
  ["project_retirement_operations_attempt_count_check", "c", "CHECK (attempt_count >= 0)"],
  ["project_retirement_operations_lease_version_check", "c", "CHECK (lease_version >= 0)"],
  [
    "project_retirement_operations_project_id_fkey",
    "f",
    "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
  ],
].map(([constraint_name, constraint_type, definition]) => ({
  constraint_name,
  constraint_type,
  definition,
}));

const canonicalRetirementIndexes = [
  [
    "project_retirement_operations_project_idx",
    "CREATE INDEX project_retirement_operations_project_idx ON public.project_retirement_operations USING btree (project_id, created_at)",
  ],
  [
    "project_retirement_operations_state_idx",
    "CREATE INDEX project_retirement_operations_state_idx ON public.project_retirement_operations USING btree (state, updated_at)",
  ],
  [
    "project_retirement_operations_active_project_uq",
    "CREATE UNIQUE INDEX project_retirement_operations_active_project_uq ON public.project_retirement_operations USING btree (project_id) WHERE ((state = ANY (ARRAY['accepted'::text, 'running'::text])) OR ((state = 'failed'::text) AND (completed_at IS NULL)))",
  ],
].map(([index_name, index_definition]) => ({ index_name, index_definition }));

function normalizedStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

describe("governed project retirement coordinator", () => {
  it("creates the canonical shape once and performs zero repair writes or DDL on run two", async () => {
    process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
    const { applyProjectRetirementOperationsMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    let tableExists = false;
    const client = {
      query: async (statement: string) => {
        const normalized = normalizedStatement(statement);
        statements.push(normalized);
        if (normalized.includes("to_regclass('project_retirement_operations')")) {
          return { rows: [{ table_exists: tableExists }], rowCount: 1 };
        }
        if (normalized.startsWith("CREATE TABLE IF NOT EXISTS")) tableExists = true;
        if (normalized.includes("FROM information_schema.columns")) {
          return { rows: canonicalRetirementColumns, rowCount: canonicalRetirementColumns.length };
        }
        if (normalized.includes("FROM pg_constraint")) {
          return {
            rows: canonicalRetirementConstraints,
            rowCount: canonicalRetirementConstraints.length,
          };
        }
        if (normalized.includes("FROM pg_indexes")) {
          return { rows: canonicalRetirementIndexes, rowCount: canonicalRetirementIndexes.length };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyProjectRetirementOperationsMigration>[0];

    await applyProjectRetirementOperationsMigration(client);
    const firstRun = [...statements];
    statements.length = 0;
    await applyProjectRetirementOperationsMigration(client);

    const secondRunRepairs = statements.filter((statement) =>
      /^(?:ALTER|CREATE|DROP|UPDATE)\b/u.test(statement),
    );
    expect(secondRunRepairs).toEqual([]);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(firstRun[0]).toBe("BEGIN");
    expect(firstRun.at(-1)).toBe("COMMIT");
    expect(firstRun.join("\n")).toContain(
      "CREATE TABLE IF NOT EXISTS project_retirement_operations",
    );
    expect(firstRun.join("\n")).toContain("lease_expires_at");
    expect(firstRun.join("\n")).toContain("failure_target JSONB");
    expect(firstRun.join("\n")).toContain("project_retirement_operations_state_check");
    expect(firstRun.join("\n")).toContain("project_retirement_operations_attempt_count_check");
    expect(firstRun.join("\n")).toContain("project_retirement_operations_lease_version_check");
    expect(firstRun.join("\n")).toContain("project_retirement_operations_project_id_fkey");
    expect(firstRun.join("\n")).toContain("ON DELETE CASCADE");
    expect(firstRun.join("\n")).toContain("project_retirement_operations_active_project_uq");
  });

  it("rolls back a partial retirement schema repair", async () => {
    process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
    const { applyProjectRetirementOperationsMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        const normalized = normalizedStatement(statement);
        statements.push(normalized);
        if (normalized.includes("to_regclass('project_retirement_operations')")) {
          return { rows: [{ table_exists: true }], rowCount: 1 };
        }
        if (normalized.includes("FROM information_schema.columns")) {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("ALTER TABLE project_retirement_operations ADD COLUMN")) {
          throw new Error("simulated-shape-repair-failure");
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyProjectRetirementOperationsMigration>[0];

    await expect(applyProjectRetirementOperationsMigration(client)).rejects.toThrow(
      "simulated-shape-repair-failure",
    );
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("repairs only catalog-proven mismatched constraint and index definitions", async () => {
    process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
    const { applyProjectRetirementOperationsMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const constraints = canonicalRetirementConstraints.map((constraint) =>
      constraint.constraint_name === "project_retirement_operations_state_check"
        ? { ...constraint, definition: "CHECK (state IN ('accepted'))" }
        : constraint,
    );
    const indexes = canonicalRetirementIndexes.map((index) =>
      index.index_name === "project_retirement_operations_project_idx"
        ? {
            ...index,
            index_definition:
              "CREATE INDEX project_retirement_operations_project_idx ON public.project_retirement_operations USING btree (project_id)",
          }
        : index,
    );
    const client = {
      query: async (statement: string) => {
        const normalized = normalizedStatement(statement);
        statements.push(normalized);
        if (normalized.includes("to_regclass('project_retirement_operations')")) {
          return { rows: [{ table_exists: true }], rowCount: 1 };
        }
        if (normalized.includes("FROM information_schema.columns")) {
          return { rows: canonicalRetirementColumns, rowCount: canonicalRetirementColumns.length };
        }
        if (normalized.includes("FROM pg_constraint")) {
          return { rows: constraints, rowCount: constraints.length };
        }
        if (normalized.includes("FROM pg_indexes")) {
          return { rows: indexes, rowCount: indexes.length };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyProjectRetirementOperationsMigration>[0];

    await applyProjectRetirementOperationsMigration(client);

    const repairs = statements.filter((statement) =>
      /^(?:ALTER|CREATE|DROP|UPDATE)\b/u.test(statement),
    );
    expect(repairs).toEqual([
      'ALTER TABLE project_retirement_operations DROP CONSTRAINT "project_retirement_operations_state_check"',
      "ALTER TABLE project_retirement_operations ADD CONSTRAINT project_retirement_operations_state_check CHECK (state IN ('accepted','running','failed','completed','canceled'))",
      'DROP INDEX "project_retirement_operations_project_idx"',
      "CREATE INDEX IF NOT EXISTS project_retirement_operations_project_idx ON project_retirement_operations(project_id, created_at)",
    ]);
    expect(repairs.some((statement) => statement.startsWith("UPDATE"))).toBe(false);
  });

  it("canonicalizes equivalent legacy constraint names once and then performs zero DDL", async () => {
    process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
    const { applyProjectRetirementOperationsMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    let aliasesPresent = true;
    const aliasedConstraints = canonicalRetirementConstraints.map((constraint, index) => ({
      ...constraint,
      constraint_name: `legacy_retirement_constraint_${index}`,
    }));
    const client = {
      query: async (statement: string) => {
        const normalized = normalizedStatement(statement);
        statements.push(normalized);
        if (normalized.includes("to_regclass('project_retirement_operations')")) {
          return { rows: [{ table_exists: true }], rowCount: 1 };
        }
        if (normalized.includes("FROM information_schema.columns")) {
          return { rows: canonicalRetirementColumns, rowCount: canonicalRetirementColumns.length };
        }
        if (normalized.includes("FROM pg_constraint")) {
          const rows = aliasesPresent ? aliasedConstraints : canonicalRetirementConstraints;
          return { rows, rowCount: rows.length };
        }
        if (normalized.includes("FROM pg_indexes")) {
          return { rows: canonicalRetirementIndexes, rowCount: canonicalRetirementIndexes.length };
        }
        if (normalized.includes("RENAME CONSTRAINT")) aliasesPresent = false;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyProjectRetirementOperationsMigration>[0];

    await applyProjectRetirementOperationsMigration(client);
    const firstRunRenames = statements.filter((statement) =>
      statement.includes("RENAME CONSTRAINT"),
    );
    expect(firstRunRenames).toHaveLength(canonicalRetirementConstraints.length);
    for (const [index, constraint] of canonicalRetirementConstraints.entries()) {
      expect(firstRunRenames[index]).toContain(`legacy_retirement_constraint_${index}`);
      expect(firstRunRenames[index]).toContain(constraint.constraint_name);
    }

    statements.length = 0;
    await applyProjectRetirementOperationsMigration(client);
    expect(
      statements.filter((statement) => /^(?:ALTER|CREATE|DROP|UPDATE)\b/u.test(statement)),
    ).toEqual([]);
  });

  it("backfills only proven nullable repair rows with an explicit predicate", async () => {
    process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
    const { applyProjectRetirementOperationsMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const columns = canonicalRetirementColumns.map((column) =>
      column.column_name === "requested_by" ? { ...column, is_nullable: "YES" } : column,
    );
    const client = {
      query: async (statement: string) => {
        const normalized = normalizedStatement(statement);
        statements.push(normalized);
        if (normalized.includes("to_regclass('project_retirement_operations')")) {
          return { rows: [{ table_exists: true }], rowCount: 1 };
        }
        if (normalized.includes("FROM information_schema.columns")) {
          return { rows: columns, rowCount: columns.length };
        }
        if (normalized.includes("AS repair_needed")) {
          return { rows: [{ repair_needed: true }], rowCount: 1 };
        }
        if (normalized.includes("FROM pg_constraint")) {
          return {
            rows: canonicalRetirementConstraints,
            rowCount: canonicalRetirementConstraints.length,
          };
        }
        if (normalized.includes("FROM pg_indexes")) {
          return { rows: canonicalRetirementIndexes, rowCount: canonicalRetirementIndexes.length };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyProjectRetirementOperationsMigration>[0];

    await applyProjectRetirementOperationsMigration(client);

    const updates = statements.filter((statement) => statement.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(
      "WHERE requested_by IS NULL OR state IS NULL OR attempt_count IS NULL",
    );
    expect(statements).toContain(
      "ALTER TABLE project_retirement_operations ALTER COLUMN requested_by SET NOT NULL",
    );
  });

  it("atomically tombstones, revokes access, and persists the returned access progress", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function acceptProjectRetirement");
    const end = source.indexOf("class ProjectRetirementStepError", start);
    const route = source.slice(start, end);
    const transaction = route.indexOf("db.transaction(async (tx)");
    const tombstone = route.indexOf("deletedAt: sql`now()`", transaction);
    const accessRevocation = route.indexOf(
      "const progress = await retireProjectAccessSurfaces(tx",
      tombstone,
    );
    const operationInsert = route.indexOf(
      "tx.insert(projectRetirementOperationsTable)",
      accessRevocation,
    );

    expect(transaction).toBeGreaterThan(-1);
    expect(route).toContain("PROJECT_LIFECYCLE_LOCK_NAMESPACE");
    expect(tombstone).toBeGreaterThan(transaction);
    expect(accessRevocation).toBeGreaterThan(tombstone);
    expect(operationInsert).toBeGreaterThan(accessRevocation);
    expect(route.slice(accessRevocation, operationInsert)).toContain(
      "progress: initialProjectRetirementProgress()",
    );
    expect(route.slice(operationInsert)).toContain("progress,");
    expect(route).toContain('state: "accepted"');
    expect(route).toContain("disableProjectDeploymentSchedulesStatement");
    expect(route.slice(operationInsert)).not.toContain('state: "completed"');
  });

  it("re-revokes access in every governed reconciliation receipt", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function requestProjectRetirementReconciliation");
    const end = source.indexOf("export async function runProjectRetirementOperation", start);
    const reconciliation = source.slice(start, end);
    const lock = reconciliation.indexOf("pg_advisory_xact_lock");
    const access = reconciliation.indexOf("retireProjectAccessSurfaces(tx", lock);
    const insert = reconciliation.indexOf("tx.insert(projectRetirementOperationsTable)", access);

    expect(lock).toBeGreaterThan(-1);
    expect(access).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(access);
    expect(reconciliation.slice(access, insert)).toContain("progress,");
  });

  it("cannot stamp completed before validating the complete current receipt", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function runProjectRetirementOperation");
    const end = source.indexOf("export async function resumeProjectRetirementOperations", start);
    const run = source.slice(start, end);
    const evidence = run.indexOf("hasCurrentProjectRetirementCompletionEvidence(progress)");
    const typedFailure = run.indexOf(
      'code: "project_retirement_completion_evidence_incomplete"',
      evidence,
    );
    const completed = run.indexOf('state: "completed"', typedFailure);

    expect(evidence).toBeGreaterThan(-1);
    expect(typedFailure).toBeGreaterThan(evidence);
    expect(completed).toBeGreaterThan(typedFailure);
  });

  it("allows only strict legacy R2 absence or no configuration and blocks unavailable cleanup", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function retireLegacyCdnObjects");
    const end = source.indexOf("async function releaseTrackedDomainSecurityResources", start);
    const legacyR2 = source.slice(start, end);
    const notConfigured = legacyR2.indexOf('if (outcome.state === "not_configured")');
    const verifiedAbsent = legacyR2.indexOf('if (outcome.state === "absent")');
    const typedFailure = legacyR2.indexOf("const code =", verifiedAbsent);
    const failedProgress = legacyR2.indexOf('progress.legacyR2.state = "failed"', typedFailure);
    const persistedFailure = legacyR2.indexOf(
      "await updateProgress(operation.id, progress, leaseVersion)",
      failedProgress,
    );
    const thrownFailure = legacyR2.indexOf(
      "throw new ProjectRetirementStepError",
      persistedFailure,
    );
    const runStart = source.indexOf("export async function runProjectRetirementOperation");
    const runEnd = source.indexOf(
      "export async function resumeProjectRetirementOperations",
      runStart,
    );
    const run = source.slice(runStart, runEnd);

    expect(notConfigured).toBeGreaterThan(-1);
    expect(legacyR2.slice(notConfigured, verifiedAbsent)).toContain(
      'progress.legacyR2.state = "not_configured"',
    );
    expect(legacyR2.slice(notConfigured, verifiedAbsent)).toContain("return;");
    expect(verifiedAbsent).toBeGreaterThan(notConfigured);
    expect(legacyR2.slice(verifiedAbsent, typedFailure)).toContain(
      'progress.legacyR2.state = "verified_absent"',
    );
    expect(legacyR2.slice(verifiedAbsent, typedFailure)).toContain("return;");
    expect(legacyR2.slice(typedFailure, failedProgress)).toContain(
      '"project_retirement_legacy_r2_release_failed"',
    );
    expect(legacyR2.slice(typedFailure, failedProgress)).toContain(
      '"project_retirement_legacy_r2_release_unverified"',
    );
    expect(failedProgress).toBeGreaterThan(typedFailure);
    expect(persistedFailure).toBeGreaterThan(failedProgress);
    expect(thrownFailure).toBeGreaterThan(persistedFailure);
    expect(run.indexOf("await retireLegacyCdnObjects")).toBeLessThan(
      run.indexOf('state: "completed"'),
    );
    expect(run.slice(run.indexOf("} catch (error)"))).toContain('state: "failed"');
    expect(run.slice(run.indexOf("} catch (error)"))).toContain("failureCode: receipt.code");
  });

  it("restores only after complete current evidence, replays safely, and never starts a runtime", () => {
    const source = readFileSync(new URL("../routes/projects.ts", import.meta.url), "utf8");
    const start = source.indexOf('router.post("/projects/:id/restore"');
    const end = source.indexOf('router.get("/projects/:id/retirement"', start);
    const restore = source.slice(start, end);

    expect(restore).toContain("const retirementEvidence = {");
    expect(restore).toContain("progress: latestRetirement?.progress ?? null");
    expect(restore).toContain("decideProjectRestoreAdmission(retirementEvidence)");
    expect(restore).toContain("hasProjectRestoreReplayReceipt(retirementEvidence)");
    expect(restore).toContain("matchesRestoredProjectControlPlaneState(ownedProject)");
    expect(restore).toContain('kind: "already_restored"');
    expect(restore).toContain('code: "project_retirement_cleanup_unverified"');
    expect(restore).toContain("eq(projectsTable.ownerId, userId)");
    expect(restore.indexOf("eq(projectsTable.ownerId, userId)")).toBeLessThan(
      restore.indexOf(".from(projectRetirementOperationsTable)"),
    );
    expect(restore).not.toContain('activeRetirement.state === "failed"');
    expect(restore).toContain("pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}");
    expect(restore).toContain("jsonb_set(");
    expect(restore).toContain("jsonb_build_object('state', 'restored', 'restoredAt', now())");
    expect(restore).toContain("sql`${projectsTable.deletedAt} IS NOT NULL`");
    expect(restore).toContain("cancelScheduledProjectPurgeForRestore(tx, params.data.id)");
    expect(restore).not.toMatch(
      /shareLinksTable|supportAccessGrantsTable|supportAccessSessionsTable|canvasVariantsTable|canvasAbTestsTable/,
    );
    expect(restore).not.toMatch(/\.start\(|enqueueProvisionProjectJob|enqueueJob/);
    const lock = restore.indexOf("pg_advisory_xact_lock");
    const ownerRead = restore.indexOf("eq(projectsTable.ownerId, userId)", lock);
    const receiptRead = restore.indexOf(".from(projectRetirementOperationsTable)", ownerRead);
    const receiptWrite = restore.indexOf("jsonb_set(", receiptRead);
    const tombstoneClear = restore.indexOf("deletedAt: null", receiptWrite);
    expect(lock).toBeGreaterThan(-1);
    expect(ownerRead).toBeGreaterThan(lock);
    expect(receiptRead).toBeGreaterThan(ownerRead);
    expect(receiptWrite).toBeGreaterThan(receiptRead);
    expect(tombstoneClear).toBeGreaterThan(receiptWrite);
  });

  it("clears pointers only after route and all three runtime absence checks", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const route = source.indexOf("await deactivatePublishedRoutes");
    const runtimes = source.indexOf("await destroyRuntimeTargets", route);
    const clearPointers = source.indexOf("publishedSnapshotId: null", runtimes);

    expect(route).toBeGreaterThan(-1);
    expect(runtimes).toBeGreaterThan(route);
    expect(clearPointers).toBeGreaterThan(runtimes);
    expect(source).toContain("await tenantRuntimeProvider.status(runtimeId)");
  });

  it("skips only the unconfigured legacy KV surface and still retires runtime routes", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function deactivatePublishedRoutes");
    const end = source.indexOf("function securityResourceKey", start);
    const route = source.slice(start, end);

    expect(route).toContain("resolveLegacyHostnameKvPosture()");
    expect(route).not.toContain("if (!process.env.CF_KV_NAMESPACE_ID)");
    expect(route).toContain('legacyKvPosture.state === "configured"');
    expect(route).toContain('? "verified_absent" : "not_configured"');
    expect(route).toContain("legacyHostnameKv: verifiedLegacyHostnameKv");
    expect(route).toContain("routeInventoryProvider.inventoryProductionRoutes");
    expect(route).toContain("routeInventoryProvider.retireObservedProductionRoute");
    expect(route.indexOf("resolveLegacyHostnameKvPosture()")).toBeLessThan(
      route.indexOf("routeInventoryProvider.inventoryProductionRoutes"),
    );
  });

  it("retains the historical testing-workflow pointer instead of misrouting it to Cloudflare", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function destroyRuntimeTargets");
    const end = source.indexOf("export async function enqueueProjectRetirementOperation", start);
    const runtimes = source.slice(start, end);
    const pointerUpdateStart = source.indexOf("const pointerUpdates =", end);
    const pointerUpdateEnd = source.indexOf("await tx", pointerUpdateStart);
    const pointerUpdates = source.slice(pointerUpdateStart, pointerUpdateEnd);

    expect(runtimes).toContain("testContainerId: projectsTable.testContainerId");
    expect(runtimes).toContain('pointer: "testContainerId"');
    expect(runtimes).toContain('reason: "legacy_runtime_provider"');
    expect(runtimes).not.toContain('{ pointer: "testContainerId" as const');
    expect(pointerUpdates).not.toContain("testContainerId: null");
  });

  it("fences stale-running crash recovery so an old worker cannot complete", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    expect(source).toContain('eq(projectRetirementOperationsTable.state, "running")');
    expect(source).toContain("lt(projectRetirementOperationsTable.leaseExpiresAt, sql`now()`)");
    expect(source).toContain(
      "eq(projectRetirementOperationsTable.leaseVersion, claimed.leaseVersion)",
    );
    expect(source).toContain(
      "leaseVersion: sql`${projectRetirementOperationsTable.leaseVersion} + 1`",
    );
  });

  it("keeps domain configuration but clears its provider certificate only after absence proof", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const strictDelete = source.indexOf("await retireCustomHostname(cfHostnameId)");
    const verified = source.indexOf('outcome.state !== "absent"', strictDelete);
    const pointerClear = source.indexOf("cfHostnameId: null", verified);

    expect(strictDelete).toBeGreaterThanOrEqual(0);
    expect(verified).toBeGreaterThan(strictDelete);
    expect(pointerClear).toBeGreaterThan(verified);
    expect(source.slice(verified, pointerClear)).toContain("ProjectRetirementStepError");
    expect(source.slice(verified, pointerClear)).toContain("db.transaction(async (tx)");
    expect(source.slice(pointerClear)).toContain("progress,");
    const purchasedRetention = source.slice(
      source.indexOf("async function retainPurchasedDomainAssignments"),
    );
    expect(purchasedRetention).toContain('receipt.state = "retained"');
    expect(purchasedRetention).not.toContain("delete(projectDomainsTable)");
    expect(purchasedRetention).not.toContain("update(purchasedDomainsTable)");
    expect(source).toContain("WHEN ${projectsTable.customDomain} IS NULL THEN 'unconfigured'");
    expect(source).toContain("ELSE 'pending_verification'");
    expect(source).toContain("sslLastCheckedAt: null");
  });

  it("deduplicates legacy and multi-domain hostname pointers under one atomic receipt", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const release = source.slice(
      source.indexOf("async function releaseCustomHostnameCertificates"),
      source.indexOf("async function retainPurchasedDomainAssignments"),
    );

    expect(release).toContain("projectsTable.cfHostnameId");
    expect(release).toContain("planHostnameCertificateRetirements");
    expect(release).toContain("legacyProjectPointer");
    expect(release).toContain("progress.hostnameCertificates");
    expect(release).toContain("db.transaction(async (tx)");
    expect(release).toContain("projectRetirementOperationsTable.leaseVersion");
  });

  it("retires strict provider hostname matches when database pointers are null or stale", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function releaseCustomHostnameCertificates");
    const end = source.indexOf("async function retainPurchasedDomainAssignments", start);
    const release = source.slice(start, end);
    const pointerPlan = release.indexOf("planHostnameCertificateRetirements");
    const inventory = release.indexOf("inventoryCustomHostnamesByHostname", pointerPlan);
    const inventoryFailure = release.indexOf(
      'if (hostnameInventory.state !== "complete")',
      inventory,
    );
    const merge = release.indexOf(
      "for (const match of hostnameInventory.matches)",
      inventoryFailure,
    );
    const providerTarget = release.indexOf("cfHostnameId: match.id", merge);
    const retirement = release.indexOf("await retireCustomHostname(cfHostnameId)", providerTarget);

    expect(pointerPlan).toBeGreaterThan(-1);
    expect(inventory).toBeGreaterThan(pointerPlan);
    expect(release.slice(inventory, inventoryFailure)).toContain("project.customDomain");
    expect(release.slice(inventory, inventoryFailure)).toContain(
      "domains.map((domain) => domain.hostname)",
    );
    expect(release.slice(inventory, inventoryFailure)).toContain(
      "purchasedDomains.map((domain) => domain.hostname)",
    );
    expect(inventoryFailure).toBeGreaterThan(inventory);
    expect(release.slice(inventoryFailure, merge)).toContain(
      'code: "project_retirement_domain_release_unverified"',
    );
    expect(merge).toBeGreaterThan(inventoryFailure);
    expect(release.slice(merge, providerTarget)).toContain("target.cfHostnameId === match.id");
    expect(providerTarget).toBeGreaterThan(merge);
    expect(release.slice(providerTarget, retirement)).toContain("hostnames: [match.hostname]");
    expect(release.slice(providerTarget, retirement)).toContain("projectDomainIds: []");
    expect(release.slice(providerTarget, retirement)).toContain("legacyProjectPointer: false");
    expect(retirement).toBeGreaterThan(providerTarget);
  });

  it("strictly inventories purchased-domain hostnames for security before certificate release", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function releaseTrackedDomainSecurityResources");
    const end = source.indexOf("async function releaseCustomHostnameCertificates", start);
    const security = source.slice(start, end);
    const purchasedRead = security.indexOf(".from(purchasedDomainsTable)");
    const inventory = security.indexOf("inventoryCustomHostnamesByHostname", purchasedRead);
    const purchasedInput = security.indexOf(
      "purchasedDomains.map((domain) => domain.hostname)",
      inventory,
    );
    const discovery = security.indexOf("discoverCloudflareSecurityResources", purchasedInput);

    expect(purchasedRead).toBeGreaterThan(-1);
    expect(inventory).toBeGreaterThan(purchasedRead);
    expect(purchasedInput).toBeGreaterThan(inventory);
    expect(discovery).toBeGreaterThan(purchasedInput);
    expect(security).toContain('code: "project_retirement_domain_security_release_unverified"');
  });

  it("retires tracked security resources and purchased assignments before runtime pointers", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const security = source.indexOf("await releaseTrackedDomainSecurityResources");
    const certificates = source.indexOf("await releaseCustomHostnameCertificates", security);
    const purchased = source.indexOf("await retainPurchasedDomainAssignments", certificates);
    const runtime = source.indexOf("await destroyRuntimeTargets", purchased);

    expect(security).toBeGreaterThan(-1);
    expect(certificates).toBeGreaterThan(security);
    expect(purchased).toBeGreaterThan(certificates);
    expect(runtime).toBeGreaterThan(purchased);
  });

  it("persists exact legacy security discovery receipts before deleting them", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const discovery = source.indexOf("discoverCloudflareSecurityResources({");
    const persisted = source.indexOf("securityConfig: discovered.securityConfig", discovery);
    const strictDelete = source.indexOf(
      "retireCloudflareSecurityResource(target.resource)",
      persisted,
    );

    expect(discovery).toBeGreaterThan(-1);
    expect(persisted).toBeGreaterThan(discovery);
    expect(strictDelete).toBeGreaterThan(persisted);
    expect(source.slice(discovery, strictDelete)).toContain(
      "projectRetirementOperationsTable.leaseVersion",
    );
  });

  it("includes a legacy-only custom domain in strict security discovery", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function releaseTrackedDomainSecurityResources");
    const end = source.indexOf("async function releaseCustomHostnameCertificates", start);
    const security = source.slice(start, end);

    expect(security).toContain("hostname: projectsTable.customDomain");
    expect(security).toContain("cfHostnameId: projectsTable.cfHostnameId");
    expect(security).toContain("const securityDomains:");
    expect(security).toContain("id: null");
    expect(security).toContain("mapInBoundedBatches(securityDomains");
    expect(security).toContain("if (discovered.domain.id === null)");
  });

  it("terminalizes an expired fourth-attempt crash with a retryable typed receipt", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const resume = source.indexOf("export async function resumeProjectRetirementOperations");
    const terminal = source.indexOf('failureCode: "project_retirement_attempts_exhausted"', resume);
    const candidateScan = source.indexOf("const operations = await db", terminal);

    expect(terminal).toBeGreaterThan(resume);
    expect(candidateScan).toBeGreaterThan(terminal);
    expect(source.slice(terminal, candidateScan)).toContain("completedAt: sql`now()`");
    expect(source.slice(terminal, candidateScan)).toContain(
      "attemptCount} >= ${PROJECT_RETIREMENT_MAX_ATTEMPTS}",
    );
  });

  it("resumes existing receipts at boot without implicitly adopting legacy tombstones", () => {
    const source = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const resume = source.indexOf("export async function resumeProjectRetirementOperations");
    const read = source.indexOf("export async function readProjectRetirementOperation", resume);
    const block = source.slice(resume, read);

    expect(block).toContain("enqueueProjectRetirementOperation(operation.id)");
    expect(block).not.toContain("projectsTable");
    expect(block).not.toContain(".insert(");
    expect(source).not.toContain("adoptLegacyProjectRetirementOperations");
  });

  it("prevents atomic file writes from racing past the project tombstone", () => {
    const source = readFileSync(new URL("./project-file-writer.ts", import.meta.url), "utf8");
    const lifecycleLock = source.indexOf("PROJECT_LIFECYCLE_LOCK_NAMESPACE");
    const tombstoneRead = source.indexOf("isNull(projectsTable.deletedAt)", lifecycleLock);
    const firstDelete = source.indexOf("tx.delete(projectFilesTable)", tombstoneRead);

    expect(lifecycleLock).toBeGreaterThan(-1);
    expect(tombstoneRead).toBeGreaterThan(lifecycleLock);
    expect(firstDelete).toBeGreaterThan(tombstoneRead);
  });
});
