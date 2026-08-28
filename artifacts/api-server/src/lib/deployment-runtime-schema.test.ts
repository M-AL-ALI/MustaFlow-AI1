import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assessDeploymentRuntimeSchema } from "./deployment-runtime-schema";

function observation(overrides: Record<string, boolean> = {}) {
  return {
    canCreateSchemaObjects: false,
    canMutateExistingObjects: false,
    adminAuthorityReady: true,
    workspaceMembershipReady: true,
    supportDeliveryReady: true,
    supportDeliveryConstraintsReady: true,
    supportDeliveryIndexesReady: true,
    promptQueueReady: true,
    projectCollaborationReady: true,
    ...overrides,
  };
}

describe("deployment runtime schema boundary", () => {
  it("accepts a complete read-only deployment schema without issuing DDL", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql.trimStart().startsWith("SELECT")).toBe(true);
      return { rows: [observation()] };
    });

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v2",
      mode: "read-only-ready",
      violations: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails closed with allowlisted evidence when the deployed schema is incomplete", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          supportDeliveryConstraintsReady: false,
          promptQueueReady: false,
        }),
      ],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v2",
      mode: "read-only-incomplete",
      violations: ["support_delivery_constraints_missing", "prompt_queue_missing"],
    });
  });

  it("preserves the existing idempotent migration path for mutable database roles", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          canCreateSchemaObjects: true,
          canMutateExistingObjects: true,
          supportDeliveryReady: false,
        }),
      ],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v2",
      mode: "mutable",
      violations: [],
    });
  });

  it("treats a deployment role that can create but cannot alter existing objects as read-only", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ canCreateSchemaObjects: true })],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v2",
      mode: "read-only-ready",
      violations: [],
    });
  });

  it("wires the read-only decision before any migration step can execute", () => {
    const source = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const assessment = source.indexOf("assessDeploymentRuntimeSchema");
    const migrationLoop = source.indexOf("for (const step of MIGRATION_STEPS)");

    expect(assessment).toBeGreaterThan(-1);
    expect(migrationLoop).toBeGreaterThan(assessment);
    expect(source).toContain('mode === "read-only-ready"');
    expect(source).toContain('name: "verify-deployment-runtime-schema"');
  });
});
