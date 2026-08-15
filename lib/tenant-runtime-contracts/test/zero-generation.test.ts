import { describe, expect, it } from "vitest";
import {
  ZERO_GENERATION_FORMAT,
  ZERO_GENERATION_ARTIFACT_COMMIT_BASELINE_MS,
  ZERO_GENERATION_ASSEMBLY_RESERVE_MS,
  ZERO_GENERATION_COLD_ASSEMBLY_BASELINE_MS,
  ZERO_GENERATION_COMMIT_RESERVE_MS,
  ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS,
  ZERO_GENERATION_OBSERVATION_BASELINE_MS,
  ZERO_GENERATION_OBSERVATION_RESERVE_MS,
  ZERO_GENERATION_PREDELIVERY_BASELINE_MS,
  ZERO_GENERATION_RESERVED_BUDGET_MS,
  ZERO_GENERATION_RUNTIME_START_BASELINE_MS,
  ZERO_GENERATION_START_RESERVE_MS,
  ZERO_GENERATION_SCHEMA_VERSION,
  ZERO_SEALED_BUILD_COMMAND,
  ZERO_SEALED_HEALTH_PATH,
  ZERO_SEALED_RUNTIME_PORT,
  ZERO_SEALED_START_COMMAND,
  zeroGeneratedDependencyPlanSchema,
  zeroSealedNodeRuntimeManifestSchema,
} from "../src";

describe("Zero sealed-generation contracts", () => {
  it("decomposes the product bound into measured named reserves", () => {
    expect(ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS).toBe(1_800_000);
    expect(ZERO_GENERATION_RESERVED_BUDGET_MS).toBe(ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS);
    expect(ZERO_GENERATION_COLD_ASSEMBLY_BASELINE_MS).toBe(494_600);
    expect(ZERO_GENERATION_PREDELIVERY_BASELINE_MS).toBe(1_039_084);
    expect(ZERO_GENERATION_ASSEMBLY_RESERVE_MS).toBeGreaterThan(
      ZERO_GENERATION_PREDELIVERY_BASELINE_MS,
    );
    expect(ZERO_GENERATION_COMMIT_RESERVE_MS).toBeGreaterThan(
      ZERO_GENERATION_ARTIFACT_COMMIT_BASELINE_MS,
    );
    expect(ZERO_GENERATION_START_RESERVE_MS).toBeGreaterThan(
      ZERO_GENERATION_RUNTIME_START_BASELINE_MS,
    );
    expect(ZERO_GENERATION_OBSERVATION_RESERVE_MS).toBe(
      ZERO_GENERATION_OBSERVATION_BASELINE_MS * 2,
    );
  });

  it("accepts a canonical dependency-intent plan", () => {
    expect(
      zeroGeneratedDependencyPlanSchema.parse({
        format: ZERO_GENERATION_FORMAT,
        schemaVersion: ZERO_GENERATION_SCHEMA_VERSION,
        target: "cloudflare-sealed-staging-v1",
        intents: [
          { ecosystem: "npm", name: "express", selector: "4.21.2" },
          { ecosystem: "npm", name: "zod", selector: "3.25.76" },
        ],
      }).intents,
    ).toHaveLength(2);
    expect(
      zeroGeneratedDependencyPlanSchema.parse({
        format: ZERO_GENERATION_FORMAT,
        schemaVersion: ZERO_GENERATION_SCHEMA_VERSION,
        target: "cloudflare-sealed-v1",
        intents: [{ ecosystem: "npm", name: "express", selector: "4.21.2" }],
      }).target,
    ).toBe("cloudflare-sealed-v1");
  });

  it("rejects unsorted or duplicate dependency intents", () => {
    const base = {
      format: ZERO_GENERATION_FORMAT,
      schemaVersion: ZERO_GENERATION_SCHEMA_VERSION,
      target: "cloudflare-sealed-staging-v1",
    } as const;
    expect(() =>
      zeroGeneratedDependencyPlanSchema.parse({
        ...base,
        intents: [
          { ecosystem: "npm", name: "zod", selector: "3.25.76" },
          { ecosystem: "npm", name: "express", selector: "4.21.2" },
        ],
      }),
    ).toThrow(/canonically sorted/u);
  });

  it("fixes the sealed Node process contract", () => {
    const manifest = {
      revision: "zero-node-manifest-v1",
      runtime: "node-api",
      buildCommand: [...ZERO_SEALED_BUILD_COMMAND],
      startCommand: [...ZERO_SEALED_START_COMMAND],
      servicePort: ZERO_SEALED_RUNTIME_PORT,
      healthPath: ZERO_SEALED_HEALTH_PATH,
      resourceProfile: "dev",
      public: false,
    };
    expect(zeroSealedNodeRuntimeManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() =>
      zeroSealedNodeRuntimeManifestSchema.parse({ ...manifest, servicePort: 3000 }),
    ).toThrow(/fixed by contract/u);
  });
});
