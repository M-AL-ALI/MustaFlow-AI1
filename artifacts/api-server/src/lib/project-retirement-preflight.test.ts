import { readFileSync } from "node:fs";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deploymentLogsTable,
  managedAddonsTable,
  projectDomainsTable,
  projectVersionsTable,
  purchasedDomainsTable,
} from "@workspace/db/schema";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import {
  decideProjectRetirementPreflight,
  presentProjectRetirementPreflightRefusal,
  PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES,
} from "./project-retirement-contract";
import {
  PROJECT_RETIREMENT_IN_FLIGHT_EAS_STATUSES,
  PROJECT_RETIREMENT_LEGACY_EAS_ENVS,
  readProjectRetirementProviderHostnameInventory,
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

async function withEnvironment(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const original = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("project retirement fail-closed preflight", () => {
  beforeEach(() => {
    vi.stubEnv("CF_ZONE_ID", "test-zone");
    vi.stubEnv("CF_API_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("aggregates complete provider-only hostname inventories without exposing their contents", async () => {
    await expect(
      readProjectRetirementProviderHostnameInventory(71, {
        readLegacyPosture: () => ({
          state: "configured",
          missingBindings: [],
          invalidInputs: [],
        }),
        readLegacyInventory: async () =>
          ({ state: "complete", observations: [{ hostname: "legacy.example" }] }) as never,
        readRuntimeInventory: async () => [{ hostname: "runtime.example" }],
      }),
    ).resolves.toEqual({ state: "complete", hasHostnameInventory: true });
  });

  it("fails provider inventory closed on blocked legacy posture, incomplete scans, or runtime errors", async () => {
    const notCalled = vi.fn();
    await expect(
      readProjectRetirementProviderHostnameInventory(72, {
        readLegacyPosture: () => ({
          state: "blocked",
          missingBindings: ["CF_API_TOKEN"],
          invalidInputs: [],
        }),
        readLegacyInventory: notCalled,
        readRuntimeInventory: notCalled,
      }),
    ).resolves.toEqual({ state: "unavailable" });
    expect(notCalled).not.toHaveBeenCalled();

    await expect(
      readProjectRetirementProviderHostnameInventory(73, {
        readLegacyPosture: () => ({
          state: "configured",
          missingBindings: [],
          invalidInputs: [],
        }),
        readLegacyInventory: async () => ({ state: "unavailable", observations: [] }),
        readRuntimeInventory: async () => null,
      }),
    ).resolves.toEqual({ state: "unavailable" });

    await expect(
      readProjectRetirementProviderHostnameInventory(74, {
        readLegacyPosture: () => ({
          state: "not_configured",
          missingBindings: [],
          invalidInputs: [],
        }),
        readLegacyInventory: async () => ({ state: "complete", observations: [] }),
        readRuntimeInventory: async () => {
          throw new Error("provider unavailable");
        },
      }),
    ).resolves.toEqual({ state: "unavailable" });

    await expect(
      readProjectRetirementProviderHostnameInventory(75, {
        readLegacyPosture: () => ({
          state: "not_configured",
          missingBindings: [],
          invalidInputs: [],
        }),
        readLegacyInventory: async () => ({ state: "complete", observations: [] }),
        readRuntimeInventory: async () => null,
      }),
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("refuses to infer legacy absence from a currently missing KV binding", async () => {
    await expect(
      readProjectRetirementProviderHostnameInventory(76, {
        readLegacyPosture: () => ({
          state: "not_configured",
          missingBindings: [],
          invalidInputs: [],
        }),
        readLegacyInventory: async () => ({ state: "complete", observations: [] }),
        readRuntimeInventory: async () => [],
      }),
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("keeps a closed refusal vocabulary and plain non-leaking messages", () => {
    expect(PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES).toEqual([
      "project_retirement_legacy_runtime_requires_migration",
      "project_retirement_managed_addon_unverified",
      "project_retirement_remote_build_in_progress",
      "project_retirement_provider_provisioning_in_progress",
      "project_retirement_provider_configuration_unavailable",
      "project_retirement_sqlite_recovery_unverified",
      "project_retirement_receipt_upgrade_in_progress",
      "project_retirement_reconciliation_required",
    ]);
    for (const code of PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES) {
      const message = presentProjectRetirementPreflightRefusal(code);
      expect(message).not.toContain(code);
      expect(message).not.toMatch(/\b(?:Fly|EAS|testContainerId|externalId)\b|provider response/iu);
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
    [
      "unavailable provider configuration",
      {
        hasLegacyRuntime: false,
        hasInFlightProviderProvisioning: false,
        hasUnavailableCloudflareCachePurge: true,
        hasUnverifiedManagedAddon: false,
        hasInFlightRemoteBuild: false,
        hasUnverifiedSqliteRecovery: false,
      },
      "project_retirement_provider_configuration_unavailable",
    ],
  ] as const)("refuses %s with its exact typed reason", (_label, input, code) => {
    expect(decideProjectRetirementPreflight(input)).toEqual({ allowed: false, code });
  });

  it("treats a stored production release as hostname inventory before mutation", async () => {
    await withEnvironment({ CF_ZONE_ID: undefined, CF_API_TOKEN: undefined }, async () => {
      const harness = readOnlyTransaction(
        new Map([
          [
            projectVersionsTable,
            [{ productionRelease: { hostname: "release-only.example.test" } }],
          ],
        ]),
      );
      const readProviderHostnameInventory = vi.fn(async () => ({
        state: "complete" as const,
        hasHostnameInventory: false,
      }));
      await expect(
        readProjectRetirementPreflight(
          harness.tx as never,
          {
            id: 76,
            containerId: null,
            prodContainerId: null,
            testContainerId: null,
            dbProvider: "none",
            provisioningStatus: "idle",
            previewDbStatus: "none",
            publicSlug: null,
            customDomain: null,
            publishedSnapshotId: 760,
          },
          { readProviderHostnameInventory },
        ),
      ).resolves.toEqual({
        allowed: false,
        code: "project_retirement_provider_configuration_unavailable",
      });
      expect(readProviderHostnameInventory).not.toHaveBeenCalled();
      expect(harness.reads.map((read) => read.table)).toContain(projectVersionsTable);
      expect(harness.tx).not.toHaveProperty("insert");
      expect(harness.tx).not.toHaveProperty("update");
      expect(harness.tx).not.toHaveProperty("delete");
    });
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
        containerId: null,
        prodContainerId: null,
        testContainerId: "legacy-machine",
        dbProvider: "none",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      },
      {
        id: 9,
        containerId: null,
        prodContainerId: null,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "provisioning",
        previewDbStatus: "none",
      },
      {
        id: 10,
        containerId: null,
        prodContainerId: null,
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

  it("admits a SQLite project so the governed worker can preserve it before runtime release", async () => {
    const harness = readOnlyTransaction(new Map());
    await expect(
      readProjectRetirementPreflight(harness.tx as never, {
        id: 8,
        containerId: null,
        prodContainerId: null,
        testContainerId: null,
        dbProvider: "sqlite",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(harness.reads.map((read) => read.table)).toEqual([
      managedAddonsTable,
      projectDomainsTable,
      purchasedDomainsTable,
      deploymentLogsTable,
    ]);
  });

  it("admits only current-namespace preview and production pointer roles", async () => {
    await withEnvironment({ CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production" }, async () => {
      const preview = await deriveRuntimeIdentity({
        namespace: "production",
        projectId: 11,
        role: "preview",
        slot: "primary",
      });
      for (const slot of ["blue", "green"] as const) {
        const production = await deriveRuntimeIdentity({
          namespace: "production",
          projectId: 11,
          role: "production",
          slot,
        });
        const harness = readOnlyTransaction(new Map());
        await expect(
          readProjectRetirementPreflight(harness.tx as never, {
            id: 11,
            containerId: preview,
            prodContainerId: production,
            testContainerId: null,
            dbProvider: "none",
            provisioningStatus: "idle",
            previewDbStatus: "none",
          }),
        ).resolves.toEqual({ allowed: true });
        expect(harness.reads).toHaveLength(4);
      }
    });
  });

  it("refuses every legacy stored-pointer signature before dependent reads", async () => {
    await withEnvironment({ CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production" }, async () => {
      const identities = {
        wrongNamespacePreview: await deriveRuntimeIdentity({
          namespace: "legacy",
          projectId: 12,
          role: "preview",
          slot: "primary",
        }),
        wrongNamespaceProduction: await deriveRuntimeIdentity({
          namespace: "legacy",
          projectId: 12,
          role: "production",
          slot: "blue",
        }),
        wrongProjectPreview: await deriveRuntimeIdentity({
          namespace: "production",
          projectId: 13,
          role: "preview",
          slot: "primary",
        }),
        wrongProjectProduction: await deriveRuntimeIdentity({
          namespace: "production",
          projectId: 13,
          role: "production",
          slot: "green",
        }),
        previewInProductionPointer: await deriveRuntimeIdentity({
          namespace: "production",
          projectId: 12,
          role: "preview",
          slot: "primary",
        }),
        productionInPreviewPointer: await deriveRuntimeIdentity({
          namespace: "production",
          projectId: 12,
          role: "production",
          slot: "blue",
        }),
      };
      const cases = [
        { containerId: "fly-preview", prodContainerId: null },
        { containerId: null, prodContainerId: "fly-production" },
        { containerId: identities.wrongNamespacePreview, prodContainerId: null },
        { containerId: null, prodContainerId: identities.wrongNamespaceProduction },
        { containerId: identities.wrongProjectPreview, prodContainerId: null },
        { containerId: null, prodContainerId: identities.wrongProjectProduction },
        { containerId: null, prodContainerId: identities.previewInProductionPointer },
        { containerId: identities.productionInPreviewPointer, prodContainerId: null },
      ];
      for (const pointers of cases) {
        const harness = readOnlyTransaction(new Map());
        await expect(
          readProjectRetirementPreflight(harness.tx as never, {
            id: 12,
            ...pointers,
            testContainerId: null,
            dbProvider: "none",
            provisioningStatus: "idle",
            previewDbStatus: "none",
          }),
        ).resolves.toEqual({
          allowed: false,
          code: "project_retirement_legacy_runtime_requires_migration",
        });
        expect(harness.reads).toEqual([]);
      }
    });
  });

  it("fails closed when a stored pointer cannot be bound to a deployment namespace", async () => {
    await withEnvironment({ CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: undefined }, async () => {
      const pointer = await deriveRuntimeIdentity({
        namespace: "production",
        projectId: 14,
        role: "preview",
        slot: "primary",
      });
      const harness = readOnlyTransaction(new Map());
      await expect(
        readProjectRetirementPreflight(harness.tx as never, {
          id: 14,
          containerId: pointer,
          prodContainerId: null,
          testContainerId: null,
          dbProvider: "none",
          provisioningStatus: "idle",
          previewDbStatus: "none",
        }),
      ).resolves.toEqual({
        allowed: false,
        code: "project_retirement_legacy_runtime_requires_migration",
      });
      expect(harness.reads).toEqual([]);
    });
  });

  it("admits a previously removed add-on whose binding and injected-secret list are absent", async () => {
    const harness = readOnlyTransaction(
      new Map([
        [
          managedAddonsTable,
          [
            {
              id: 91,
              kind: "redis_kv",
              status: "removed",
              externalId: null,
              connectionInfo: null,
              injectedEnvKeys: [],
              removedAt: new Date(),
            },
          ],
        ],
      ]),
    );
    await expect(
      readProjectRetirementPreflight(harness.tx as never, {
        id: 19,
        containerId: null,
        prodContainerId: null,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(harness.reads.map((read) => read.table)).toEqual([
      managedAddonsTable,
      projectDomainsTable,
      purchasedDomainsTable,
      deploymentLogsTable,
    ]);
  });

  it("admits current binding-only add-ons but refuses an unknown provider before mutation", async () => {
    const baseProject = {
      id: 191,
      containerId: null,
      prodContainerId: null,
      testContainerId: null,
      dbProvider: "none",
      provisioningStatus: "idle",
      previewDbStatus: "none",
    };
    const known = readOnlyTransaction(
      new Map([
        [
          managedAddonsTable,
          [
            {
              id: 92,
              kind: "object_storage",
              status: "active",
              externalId: "binding-only",
              connectionInfo: { provider: "cloudflare-r2" },
              injectedEnvKeys: ["OBJECT_STORAGE_BUCKET"],
              removedAt: null,
            },
          ],
        ],
      ]),
    );
    await expect(readProjectRetirementPreflight(known.tx as never, baseProject)).resolves.toEqual({
      allowed: true,
    });

    const unknown = readOnlyTransaction(
      new Map([
        [
          managedAddonsTable,
          [
            {
              id: 93,
              kind: "object_storage",
              status: "active",
              externalId: "provider-owned",
              connectionInfo: { provider: "future-provider" },
              injectedEnvKeys: ["OBJECT_STORAGE_BUCKET"],
              removedAt: null,
            },
          ],
        ],
      ]),
    );
    await expect(readProjectRetirementPreflight(unknown.tx as never, baseProject)).resolves.toEqual(
      {
        allowed: false,
        code: "project_retirement_managed_addon_unverified",
      },
    );
    expect(unknown.tx).not.toHaveProperty("insert");
    expect(unknown.tx).not.toHaveProperty("update");
    expect(unknown.tx).not.toHaveProperty("delete");
  });

  it("refuses a public slug when Cloudflare retirement bindings are missing without writes", async () => {
    await withEnvironment({ CF_ZONE_ID: undefined, CF_API_TOKEN: undefined }, async () => {
      const harness = readOnlyTransaction(new Map());
      await expect(
        readProjectRetirementPreflight(harness.tx as never, {
          id: 20,
          containerId: null,
          prodContainerId: null,
          testContainerId: null,
          dbProvider: "none",
          provisioningStatus: "idle",
          previewDbStatus: "none",
          publicSlug: "public-project",
        }),
      ).resolves.toEqual({
        allowed: false,
        code: "project_retirement_provider_configuration_unavailable",
      });
      expect(harness.reads.map((read) => read.table)).toEqual([
        managedAddonsTable,
        projectDomainsTable,
        purchasedDomainsTable,
        deploymentLogsTable,
      ]);
      expect(harness.tx).not.toHaveProperty("insert");
      expect(harness.tx).not.toHaveProperty("update");
      expect(harness.tx).not.toHaveProperty("delete");
    });
  });

  it("permits missing Cloudflare retirement bindings when no public hostname exists", async () => {
    await withEnvironment({ CF_ZONE_ID: undefined, CF_API_TOKEN: undefined }, async () => {
      const harness = readOnlyTransaction(new Map());
      const readProviderHostnameInventory = vi.fn(async () => ({
        state: "complete" as const,
        hasHostnameInventory: false,
      }));
      await expect(
        readProjectRetirementPreflight(
          harness.tx as never,
          {
            id: 21,
            containerId: null,
            prodContainerId: null,
            testContainerId: null,
            dbProvider: "none",
            provisioningStatus: "idle",
            previewDbStatus: "none",
            publicSlug: null,
            customDomain: null,
          },
          { readProviderHostnameInventory },
        ),
      ).resolves.toEqual({ allowed: true });
      expect(readProviderHostnameInventory).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["provider-only hostname", { state: "complete", hasHostnameInventory: true } as const],
    ["unavailable provider inventory", { state: "unavailable" } as const],
  ])(
    "refuses %s before any mutation when cache bindings are missing",
    async (_label, providerInventory) => {
      await withEnvironment({ CF_ZONE_ID: undefined, CF_API_TOKEN: undefined }, async () => {
        const harness = readOnlyTransaction(new Map());
        const readProviderHostnameInventory = vi.fn(async () => providerInventory);
        await expect(
          readProjectRetirementPreflight(
            harness.tx as never,
            {
              id: 75,
              containerId: null,
              prodContainerId: null,
              testContainerId: null,
              dbProvider: "none",
              provisioningStatus: "idle",
              previewDbStatus: "none",
              publicSlug: null,
              customDomain: null,
            },
            { readProviderHostnameInventory },
          ),
        ).resolves.toEqual({
          allowed: false,
          code: "project_retirement_provider_configuration_unavailable",
        });
        expect(readProviderHostnameInventory).toHaveBeenCalledOnce();
        expect(harness.tx).not.toHaveProperty("insert");
        expect(harness.tx).not.toHaveProperty("update");
        expect(harness.tx).not.toHaveProperty("delete");
      });
    },
  );

  it.each([
    [projectDomainsTable, 22],
    [purchasedDomainsTable, 23],
  ])("refuses %s inventory when Cloudflare retirement bindings are missing", async (table, id) => {
    await withEnvironment({ CF_ZONE_ID: undefined, CF_API_TOKEN: undefined }, async () => {
      const harness = readOnlyTransaction(new Map([[table, [{ id: 1 }]]]));
      await expect(
        readProjectRetirementPreflight(harness.tx as never, {
          id,
          containerId: null,
          prodContainerId: null,
          testContainerId: null,
          dbProvider: "none",
          provisioningStatus: "idle",
          previewDbStatus: "none",
        }),
      ).resolves.toEqual({
        allowed: false,
        code: "project_retirement_provider_configuration_unavailable",
      });
    });
  });

  it("permits public hostname retirement when the complete Cloudflare binding pair exists", async () => {
    await withEnvironment({ CF_ZONE_ID: "zone-id", CF_API_TOKEN: "api-token" }, async () => {
      const harness = readOnlyTransaction(new Map([[projectDomainsTable, [{ id: 1 }]]]));
      const readProviderHostnameInventory = vi.fn(async () => ({ state: "unavailable" as const }));
      await expect(
        readProjectRetirementPreflight(
          harness.tx as never,
          {
            id: 25,
            containerId: null,
            prodContainerId: null,
            testContainerId: null,
            dbProvider: "none",
            provisioningStatus: "idle",
            previewDbStatus: "none",
            publicSlug: "public-project",
          },
          { readProviderHostnameInventory },
        ),
      ).resolves.toEqual({ allowed: true });
      expect(readProviderHostnameInventory).not.toHaveBeenCalled();
    });
  });

  it("detects only project-scoped nonterminal EAS rows and otherwise permits retirement", async () => {
    const blocked = readOnlyTransaction(new Map([[deploymentLogsTable, [{ id: 44 }]]]));
    await expect(
      readProjectRetirementPreflight(blocked.tx as never, {
        id: 23,
        containerId: null,
        prodContainerId: null,
        testContainerId: null,
        dbProvider: "postgres",
        provisioningStatus: "ready",
        previewDbStatus: "ready",
      }),
    ).resolves.toEqual({
      allowed: false,
      code: "project_retirement_remote_build_in_progress",
    });
    const deploymentLogRead = blocked.reads.find((read) => read.table === deploymentLogsTable);
    expect(deploymentLogRead).toBeDefined();
    const easRead = render(deploymentLogRead!.predicate);
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
        containerId: null,
        prodContainerId: null,
        testContainerId: null,
        dbProvider: "none",
        provisioningStatus: "idle",
        previewDbStatus: "none",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(allowed.reads.map((read) => read.table)).toEqual([
      managedAddonsTable,
      projectDomainsTable,
      purchasedDomainsTable,
      deploymentLogsTable,
    ]);
    expect(allowed.reads.map((read) => read.limit)).toEqual([4, 1, 1, 1]);
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
    expect(accept).toContain("containerId: projectsTable.containerId");
    expect(accept).toContain("prodContainerId: projectsTable.prodContainerId");
    expect(accept.indexOf('state: "refused" as const')).toBeLessThan(
      accept.indexOf(".update(projectsTable)"),
    );
    const preliminaryRead = retirement.slice(
      retirement.indexOf("export async function preflightProjectRetirement"),
      retirement.indexOf("export async function acceptProjectRetirement"),
    );
    expect(preliminaryRead).toContain("readProjectRetirementPreflight(tx, existing)");
    expect(preliminaryRead).toContain("containerId: projectsTable.containerId");
    expect(preliminaryRead).toContain("prodContainerId: projectsTable.prodContainerId");
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
