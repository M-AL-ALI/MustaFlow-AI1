import { z } from "zod";
import { pantryPackageIntentSchema } from "./pantry";
import type { PantryPlatform } from "./pantry";
import { runtimeManifestContractSchema } from "./control-schemas";

export const ZERO_GENERATION_SCHEMA_VERSION = 1 as const;
export const ZERO_GENERATION_FORMAT = "nabu-zero-generation/v1" as const;

export const ZERO_GENERATION_TARGETS = ["legacy-v1", "cloudflare-sealed-staging-v1"] as const;
export const zeroGenerationTargetSchema = z.enum(ZERO_GENERATION_TARGETS);
export type ZeroGenerationTarget = z.infer<typeof zeroGenerationTargetSchema>;

/**
 * The sealed generator is deliberately inert unless all three deployment-owned
 * locks are present. No request or project field can select this target.
 */
export const ZERO_SEALED_GENERATION_GATE_ENV = "NABUFLOW_ZERO_GENERATION_TARGET" as const;
export const ZERO_SEALED_GENERATION_GATE_VALUE = "cloudflare-sealed-staging-v1" as const;
export const ZERO_SEALED_DEPLOYMENT_NAMESPACE = "staging" as const;
export const ZERO_PANTRY_PUBLIC_KEYS_ENV = "NABUFLOW_PANTRY_TRUSTED_PUBLIC_KEYS" as const;
export const ZERO_SEALED_RUNTIME_PORT = 8080 as const;
export const ZERO_SEALED_HEALTH_PATH = "/healthz" as const;
export const ZERO_SEALED_BUILD_COMMAND = ["npm", "run", "build"] as const;
/** Build-plane appDirectory is `dist`, preserving the compiled src/ layout. */
export const ZERO_SEALED_START_COMMAND = ["node", "src/index.js"] as const;
/** Measured staging baselines retained as contract evidence for budget derivation. */
export const ZERO_GENERATION_COLD_ASSEMBLY_BASELINE_MS = 494_600;
export const ZERO_GENERATION_PREDELIVERY_BASELINE_MS = 1_039_084;
export const ZERO_GENERATION_ARTIFACT_COMMIT_BASELINE_MS = 154_306;
export const ZERO_GENERATION_RUNTIME_START_BASELINE_MS = 49_378;
export const ZERO_GENERATION_OBSERVATION_BASELINE_MS = 30_000;

/**
 * The 30-minute kitchen is decomposed rather than treated as one fungible timeout.
 * Pre-delivery retains 100,916 ms over its measured full-path baseline; commit and
 * start retain their existing five-minute provider bounds; observation doubles the
 * established 30-second durable-operation margin.
 */
export const ZERO_GENERATION_ASSEMBLY_RESERVE_MS = 1_140_000;
export const ZERO_GENERATION_COMMIT_RESERVE_MS = 300_000;
export const ZERO_GENERATION_START_RESERVE_MS = 300_000;
export const ZERO_GENERATION_OBSERVATION_RESERVE_MS = 60_000;
export const ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS = 1_800_000;
export const ZERO_GENERATION_RESERVED_BUDGET_MS =
  ZERO_GENERATION_ASSEMBLY_RESERVE_MS +
  ZERO_GENERATION_COMMIT_RESERVE_MS +
  ZERO_GENERATION_START_RESERVE_MS +
  ZERO_GENERATION_OBSERVATION_RESERVE_MS;
/**
 * The inner transport follower must yield before the kitchen deadline so the
 * kitchen can refresh durable Pantry progress and retain typed error authority.
 */
export const ZERO_GENERATION_INNER_FOLLOWER_MARGIN_MS = 5_000;
export const ZERO_SEALED_BUILD_PLATFORM = Object.freeze({
  runtime: "node",
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux",
  cpu: "x64",
  libc: "glibc",
  toolchainImageDigest: "sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738",
} satisfies PantryPlatform);

export const zeroGeneratedDependencyPlanSchema = z
  .object({
    format: z.literal(ZERO_GENERATION_FORMAT),
    schemaVersion: z.literal(ZERO_GENERATION_SCHEMA_VERSION),
    target: z.literal("cloudflare-sealed-staging-v1"),
    intents: z.array(pantryPackageIntentSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((plan, context) => {
    let previous: string | null = null;
    for (const [index, intent] of plan.intents.entries()) {
      const key = `${intent.ecosystem}:${intent.name}\0${intent.selector}`;
      if (previous !== null && previous >= key) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intents", index],
          message: "Dependency intents must be unique and canonically sorted",
        });
      }
      previous = key;
    }
  });

export const zeroSealedNodeRuntimeManifestSchema = runtimeManifestContractSchema.superRefine(
  (manifest, context) => {
    const expected = {
      runtime: "node-api",
      buildCommand: [...ZERO_SEALED_BUILD_COMMAND],
      startCommand: [...ZERO_SEALED_START_COMMAND],
      servicePort: ZERO_SEALED_RUNTIME_PORT,
      healthPath: ZERO_SEALED_HEALTH_PATH,
      resourceProfile: "dev",
      public: false,
    } as const;
    for (const key of [
      "runtime",
      "servicePort",
      "healthPath",
      "resourceProfile",
      "public",
    ] as const) {
      if (manifest[key] !== expected[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Sealed Node manifest ${key} is fixed by contract`,
        });
      }
    }
    for (const key of ["buildCommand", "startCommand"] as const) {
      if (JSON.stringify(manifest[key]) !== JSON.stringify(expected[key])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Sealed Node manifest ${key} is fixed by contract`,
        });
      }
    }
  },
);

export type ZeroGeneratedDependencyPlan = z.infer<typeof zeroGeneratedDependencyPlanSchema>;
