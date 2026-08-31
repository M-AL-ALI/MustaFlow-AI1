import { readFileSync } from "node:fs";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { deploymentLogsTable, managedAddonsTable } from "@workspace/db/schema";
import {
  decideProjectRetirementPreflight,
  presentProjectRetirementPreflightRefusal,
  PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES,
} from "./project-retirement-contract";
import {
  PROJECT_RETIREMENT_IN_FLIGHT_EAS_STATUSES,
  PROJECT_RETIREMENT_LEGACY_EAS_ENVS,
  readProjectRetirementPreflight,
} from "./project-retirement-preflight";

type Read = { table: unknown; predicate: SQL; limit: number };

function readOnlyTransaction(rows: Map<unknown, Array<Record<string, unknown>>>) {
  const reads: Read[] = [];
  const tx = {
    select() {
      return {
        from(table: unknown) {
          return {
            where(predicate: SQL) {
              return {
                async limit(limit: number) {
                  reads.push({ table, predicate, limit });
                  return (rows.get(table) ?? []).slice(0, limit);
                },
              };
            },
          };
        },
      };
    },
  };
  return { tx, reads };
}

function render(predicate: SQL): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(predicate);
  return { sql: query.sql.replace(/\s+/gu, " ").trim(), params: query.params };
}

describe("project retirement fail-closed preflight", () => {
  it("keeps a closed refusal vocabulary and plain non-leaking messages", () => {
    expect(PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES).toEqual([
      "project_retirement_legacy_runtime_requires_migration",
      "project_retirement_managed_addon_unverified",
      "project_retirement_remote_build_in_progress",
      "project_retirement_provider_provisioning_in_progress",
      "project_retirement_sqlite_recovery_unverified",
      "project_retirement_receipt_upgrade_in_progress",
      "project_retirement_reconciliation_required",
    ]);
    for (const code of PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES) {
      const message = presentProjectRetirementPreflightRefusal(code);
      expect(message).not.toContain(code);
      expect(message).not.toMatch(/Fly|EAS|testContainerId|externalId|provider response/iu);
      expect(message.length).toBeLessThanOrEqual(140);
    }
  });

  it.each([
    [
      "historical runtime",
      {
        hasLegacyRuntime: true,
        hasInFlightProviderProvisioning: false,
        hasUnverifiedManagedAddon: false,
        hasInFlightRemoteBuild: false,
        hasUnverifiedSqliteRecovery: false,
      },
      "project_retirement_legacy_runtime_requires_migration",
    ],
    [
      "runtime-backed SQLite",
      {
        hasLegacyRuntime: false,
        hasInFlightProviderProvisioning: false,
        hasUnverifiedManagedAddon: false,
        hasInFlightRemoteBuild: false,
        hasUnverifiedSqliteRecovery: true,
      },
      "project_retirement_sqlite_recovery_unverified",
    ],
    [
      "unverified add-on",
      {
        hasLegacyRuntime: false,
        hasInFlightProviderProvisioning: false,
        hasUnverifiedManagedAddon: true,
        hasInFlightRemoteBuild: false,
        hasUnverifiedSqliteRecovery: false,
      },
      "project_retirement_managed_addon_unverified",
    ],
    [
      "in-flight remote build",
      {
        hasLegacyRuntime: false,
        hasInFlightProviderProvisioning: false,
        hasUnverifiedManagedAddon: false,
        hasInFlightRemoteBuild: true,
        hasUnverifiedSqliteRecovery: false,
      },
      "project_retirement_remote_build_in_progress",
    ],
    [
      "in-flight provider provisioning",
      {
        hasLegacyRuntime: false,
        hasInFlightProviderProvisioning: true,
        hasUnverifiedManagedAddon: false,
        hasInFlightRemoteBuild: false,
        hasUnverifiedSqliteRecovery: false,
      },
      "project_retirement_provider_provisioning_in_progress",
    ],
  ] as const)("refuses %s with its exact typed reason", (_label, input, code) => {
    expect(decideProjectRetirementPreflight(input)).toEqual({ allowed: false, code });
  });

  it("admits only a project with no captured hazard", () => {
    expect(
      decideProjectRetirementPreflight({
        hasLegacyRuntime: false,
        hasInFlightProviderProvisioning: false,
        hasUnverifiedManagedAddon: false,
        hasInFlightRemoteBuild: false,
        hasUnverifiedSqliteRecovery: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses project-fact hazards without issuing any dependent-resource query", async () => {
    for (const project of [
      {
        id: 7,
        testContainerId: "legacy-machine",
        dbProvider: "none",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      },
      {
        id: 8,
        testContainerId: null,
        dbProvider: "sqlite",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      },
      {
        id: 9,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "provisioning",
        previewDbStatus: "none",
      },
      {
        id: 10,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "ready",
        previewDbStatus: "provisioning",
      },
    ]) {
      const harness = readOnlyTransaction(new Map());
      const result = await readProjectRetirementPreflight(harness.tx as never, project);
      expect(result.allowed).toBe(false);
      expect(harness.reads).toEqual([]);
    }
  });

  it("treats every managed add-on row as unverified because no provider absence receipt exists", async () => {
    const harness = readOnlyTransaction(
      new Map([[managedAddonsTable, [{ id: 91, status: "removed", removedAt: new Date() }]]]),
    );
    await expect(
      readProjectRetirementPreflight(harness.tx as never, {
        id: 19,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      }),
    ).resolves.toEqual({
      allowed: false,
      code: "project_retirement_managed_addon_unverified",
    });
    expect(harness.reads.map((read) => read.table)).toEqual([
      managedAddonsTable,
      deploymentLogsTable,
    ]);
  });

  it("detects only project-scoped nonterminal EAS rows and otherwise permits retirement", async () => {
    const blocked = readOnlyTransaction(new Map([[deploymentLogsTable, [{ id: 44 }]]]));
    await expect(
      readProjectRetirementPreflight(blocked.tx as never, {
        id: 23,
        testContainerId: null,
        dbProvider: "postgres",
        provisioningStatus: "ready",
        previewDbStatus: "ready",
      }),
    ).resolves.toEqual({
      allowed: false,
      code: "project_retirement_remote_build_in_progress",
    });
    const easRead = render(blocked.reads[1]!.predicate);
    expect(easRead.sql).toContain('"deployment_logs"."project_id" = $1');
    expect(easRead.sql).toContain('"deployment_logs"."env" like $2');
    expect(easRead.sql).toContain('"deployment_logs"."env" in ($3, $4)');
    expect(easRead.sql).toContain('"deployment_logs"."status" in ($5, $6, $7, $8)');
    expect(easRead.params).toEqual([
      23,
      "eas-%",
      ...PROJECT_RETIREMENT_LEGACY_EAS_ENVS,
      ...PROJECT_RETIREMENT_IN_FLIGHT_EAS_STATUSES,
    ]);

    const allowed = readOnlyTransaction(new Map());
    await expect(
      readProjectRetirementPreflight(allowed.tx as never, {
        id: 24,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(allowed.reads).toHaveLength(2);
    expect(allowed.reads.every((read) => read.limit === 1)).toBe(true);
    expect(allowed.tx).not.toHaveProperty("insert");
    expect(allowed.tx).not.toHaveProperty("update");
    expect(allowed.tx).not.toHaveProperty("delete");
  });

  it("runs the preflight before the first durable mutation and handles refusal before enqueue", () => {
    const retirement = readFileSync(new URL("./project-retirement.ts", import.meta.url), "utf8");
    const accept = retirement.slice(
      retirement.indexOf("export async function acceptProjectRetirement"),
      retirement.indexOf("class ProjectRetirementStepError"),
    );
    expect(accept.indexOf("readProjectRetirementPreflight(tx, existing)")).toBeGreaterThan(-1);
    expect(accept.indexOf("readProjectRetirementPreflight(tx, existing)")).toBeLessThan(
      accept.indexOf(".update(projectsTable)"),
    );
    expect(accept.indexOf('state: "refused" as const')).toBeLessThan(
      accept.indexOf(".update(projectsTable)"),
    );
    const preliminaryRead = retirement.slice(
      retirement.indexOf("export async function preflightProjectRetirement"),
      retirement.indexOf("export async function acceptProjectRetirement"),
    );
    expect(preliminaryRead).toContain("readProjectRetirementPreflight(tx, existing)");
    expect(preliminaryRead).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.execute\(/u);

    const routes = readFileSync(new URL("../routes/projects.ts", import.meta.url), "utf8");
    const ownerDelete = routes.slice(
      routes.indexOf('router.delete("/projects/:id"'),
      routes.indexOf("// ── GET /api/projects/:id/container-health"),
    );
    expect(ownerDelete.indexOf('result.state === "refused"')).toBeGreaterThan(-1);
    expect(ownerDelete.indexOf('result.state === "refused"')).toBeLessThan(
      ownerDelete.indexOf("enqueueProjectRetirementOperation(result.operationId)"),
    );
    expect(ownerDelete.indexOf("preflightProjectRetirement({")).toBeLessThan(
      ownerDelete.indexOf("cancelLocalProjectJobs(params.data.id)"),
    );
    expect(ownerDelete.indexOf('preliminary.state === "refused"')).toBeLessThan(
      ownerDelete.indexOf("cancelLocalProjectJobs(params.data.id)"),
    );
    expect(ownerDelete).toContain("deleted: false");
    expect(ownerDelete).toContain("cleanupScheduled: false");

    const adminBatch = routes.slice(
      routes.indexOf('router.post(\n  "/admin/projects/retirement/batch"'),
      routes.indexOf('router.get("/projects/:id"'),
    );
    expect(adminBatch.indexOf("preflightProjectRetirement({")).toBeLessThan(
      adminBatch.indexOf("cancelLocalProjectJobs(projectId)"),
    );
    expect(adminBatch).toContain("allowLegacyDeleted: true");
    expect(adminBatch.indexOf('preliminary.state === "refused"')).toBeLessThan(
      adminBatch.indexOf("cancelLocalProjectJobs(projectId)"),
    );
  });
});
