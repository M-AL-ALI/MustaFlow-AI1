import { z } from "zod";
import { acceptanceLeaseCheckpointSchema } from "./acceptance-provisioner";
import { productionDatabaseCheckpointSchema } from "./production-database";

/**
 * The durable executor must reach a terminal state before the provider stops
 * observing it. Keep the observation margin inside the product-level bound so
 * an alarm/redelivery terminal can always be replayed without a boundary race.
 */
export const DURABLE_OPERATION_PROVIDER_BOUND_MS = 5 * 60_000;
export const DURABLE_OPERATION_OBSERVATION_MARGIN_MS = 30_000;
export const DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS =
  DURABLE_OPERATION_PROVIDER_BOUND_MS - DURABLE_OPERATION_OBSERVATION_MARGIN_MS;
export const DURABLE_OPERATION_LEASE_MS = 15_000;
export const DURABLE_OPERATION_QUEUE_WATCHDOG_MS = 5_000;

// Compatibility aliases keep the shipped artifact-commit contract byte-for-byte stable while
// commit and lifecycle operations consume the same durable-job timing policy.
export const ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS = DURABLE_OPERATION_PROVIDER_BOUND_MS;
export const ARTIFACT_COMMIT_OBSERVATION_MARGIN_MS = DURABLE_OPERATION_OBSERVATION_MARGIN_MS;
export const ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS =
  DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS;
export const ARTIFACT_COMMIT_LEASE_MS = DURABLE_OPERATION_LEASE_MS;
export const ARTIFACT_COMMIT_QUEUE_WATCHDOG_MS = DURABLE_OPERATION_QUEUE_WATCHDOG_MS;

export const ARTIFACT_COMMIT_EVENT_LIMIT = 128;
export const DURABLE_OPERATION_DISCOVERY_MAX_LIMIT = 100;
export const DURABLE_OPERATION_DISCOVERY_MAX_WINDOW_MS = 24 * 60 * 60_000;

export const artifactCommitKindSchema = z.enum(["v1", "layers-v1"]);
export const durableOperationKindSchema = z.enum([
  "v1",
  "layers-v1",
  "runtime-start",
  "runtime-manifest-restart",
  "acceptance-lease",
  "layered-artifact-promotion",
  "production-database",
]);
export const artifactCommitCheckpointSchema = z.enum([
  "initialized",
  "verification-complete",
  "payloads-transferred",
  "unpack-complete",
  "finalized",
]);
export const runtimeStartCheckpointSchema = z.enum([
  "initialized",
  "artifact-verified",
  "materialized",
  "process-started",
  "finalized",
]);
export const runtimeManifestRestartCheckpointSchema = z.enum([
  "initialized",
  "runtime-unbound",
  "manifest-persisted",
  "materialized",
  "process-started",
  "finalized",
]);
export const acceptanceLeaseDurableCheckpointSchema = acceptanceLeaseCheckpointSchema;
export const layeredArtifactPromotionCheckpointSchema = z.enum([
  "initialized",
  "source-verified",
  "target-created",
  "payloads-copied",
  "finalized",
]);
export const productionDatabaseDurableCheckpointSchema = productionDatabaseCheckpointSchema;
export const durableOperationCheckpointSchema = z.union([
  artifactCommitCheckpointSchema,
  runtimeStartCheckpointSchema,
  runtimeManifestRestartCheckpointSchema,
  acceptanceLeaseDurableCheckpointSchema,
  layeredArtifactPromotionCheckpointSchema,
  productionDatabaseDurableCheckpointSchema,
]);
export const artifactCommitEventKindSchema = z.enum([
  "job-created",
  "request-observed",
  "queue-nudged",
  "deployment-version-deferred",
  "driver-claimed",
  "driver-adopted",
  "driver-busy",
  "lease-renewed",
  "lease-expired",
  "checkpoint-advanced",
  "alarm-redelivery",
  "driver-succeeded",
  "driver-failed",
  "deadline-terminal",
  "queue-unavailable",
]);

export const artifactCommitEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    event: artifactCommitEventKindSchema,
    attempt: z.number().int().nonnegative(),
    checkpoint: artifactCommitCheckpointSchema,
    deploymentVersion: z.string().min(1).max(100).optional(),
  })
  .strict();

export const artifactCommitDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    job: z
      .object({
        kind: artifactCommitKindSchema,
        runtimeIdentity: z.string().min(1).max(200),
        sealedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
        state: z.enum(["active", "succeeded", "failed"]),
        checkpoint: artifactCommitCheckpointSchema,
        attempt: z.number().int().nonnegative(),
        leaseUntil: z.string().datetime({ offset: true }).nullable(),
        deadline: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        terminal: z
          .object({
            status: z.number().int().min(100).max(599),
            code: z.string().min(1).max(100),
          })
          .strict()
          .nullable(),
        events: z.array(artifactCommitEventSchema).max(ARTIFACT_COMMIT_EVENT_LIMIT),
      })
      .strict(),
  })
  .strict();

export const layeredArtifactPromotionDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    job: z
      .object({
        kind: z.literal("layered-artifact-promotion"),
        runtimeIdentity: z.string().min(1).max(200),
        promotionIdentity: z.string().regex(/^[0-9a-f]{64}$/),
        state: z.enum(["active", "succeeded", "failed"]),
        checkpoint: layeredArtifactPromotionCheckpointSchema,
        attempt: z.number().int().nonnegative(),
        leaseUntil: z.string().datetime({ offset: true }).nullable(),
        deadline: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        terminal: z
          .object({
            status: z.number().int().min(100).max(599),
            code: z.string().min(1).max(100),
          })
          .strict()
          .nullable(),
        events: z
          .array(
            artifactCommitEventSchema.extend({
              checkpoint: layeredArtifactPromotionCheckpointSchema,
            }),
          )
          .max(ARTIFACT_COMMIT_EVENT_LIMIT),
      })
      .strict(),
  })
  .strict();

export const productionDatabaseDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    job: z
      .object({
        kind: z.literal("production-database"),
        runtimeIdentity: z.string().min(1).max(200),
        allocationIdentity: z.string().regex(/^[0-9a-f]{64}$/),
        action: z.enum(["ensure", "release"]),
        state: z.enum(["active", "succeeded", "failed"]),
        checkpoint: productionDatabaseCheckpointSchema,
        attempt: z.number().int().nonnegative(),
        leaseUntil: z.string().datetime({ offset: true }).nullable(),
        deadline: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        terminal: z
          .object({
            status: z.number().int().min(100).max(599),
            code: z.string().min(1).max(100),
          })
          .strict()
          .nullable(),
        events: z
          .array(
            artifactCommitEventSchema.extend({
              checkpoint: productionDatabaseCheckpointSchema,
            }),
          )
          .max(ARTIFACT_COMMIT_EVENT_LIMIT),
      })
      .strict(),
  })
  .strict();

export const durableOperationDiscoveryRequestSchema = z
  .object({
    since: z.string().datetime({ offset: true }),
    limit: z.number().int().min(1).max(DURABLE_OPERATION_DISCOVERY_MAX_LIMIT).default(50),
    kind: durableOperationKindSchema.optional(),
  })
  .strict();

export const durableOperationDiscoveryResponseSchema = z
  .object({
    ok: z.literal(true),
    window: z
      .object({
        since: z.string().datetime({ offset: true }),
        until: z.string().datetime({ offset: true }),
        limit: z.number().int().min(1).max(DURABLE_OPERATION_DISCOVERY_MAX_LIMIT),
      })
      .strict(),
    jobs: z
      .array(
        z
          .object({
            jobKey: z.string().min(1).max(1_000),
            kind: durableOperationKindSchema,
            runtimeIdentity: z.string().min(1).max(200),
            subjectKey: z.string().min(1).max(200),
            createdAt: z.string().datetime({ offset: true }),
            updatedAt: z.string().datetime({ offset: true }),
            state: z.enum(["active", "succeeded", "failed"]),
            checkpoint: durableOperationCheckpointSchema,
            attempt: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(DURABLE_OPERATION_DISCOVERY_MAX_LIMIT),
  })
  .strict();

export const runtimeStartDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    job: z
      .object({
        kind: z.literal("runtime-start"),
        runtimeIdentity: z.string().min(1).max(200),
        artifactRevision: z.string().min(1).max(200),
        artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
        state: z.enum(["active", "succeeded", "failed"]),
        checkpoint: runtimeStartCheckpointSchema,
        attempt: z.number().int().nonnegative(),
        leaseUntil: z.string().datetime({ offset: true }).nullable(),
        deadline: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        terminal: z
          .object({
            status: z.number().int().min(100).max(599),
            code: z.string().min(1).max(100),
          })
          .strict()
          .nullable(),
        events: z
          .array(
            artifactCommitEventSchema.extend({
              checkpoint: runtimeStartCheckpointSchema,
            }),
          )
          .max(ARTIFACT_COMMIT_EVENT_LIMIT),
      })
      .strict(),
  })
  .strict();

export const runtimeManifestRestartDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    job: z
      .object({
        kind: z.literal("runtime-manifest-restart"),
        runtimeIdentity: z.string().min(1).max(200),
        expectedManifestRevision: z.string().min(1).max(200),
        manifestRevision: z.string().min(1).max(200),
        state: z.enum(["active", "succeeded", "failed"]),
        checkpoint: runtimeManifestRestartCheckpointSchema,
        attempt: z.number().int().nonnegative(),
        leaseUntil: z.string().datetime({ offset: true }).nullable(),
        deadline: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        terminal: z
          .object({
            status: z.number().int().min(100).max(599),
            code: z.string().min(1).max(100),
          })
          .strict()
          .nullable(),
        events: z
          .array(
            artifactCommitEventSchema.extend({
              checkpoint: runtimeManifestRestartCheckpointSchema,
            }),
          )
          .max(ARTIFACT_COMMIT_EVENT_LIMIT),
      })
      .strict(),
  })
  .strict();

export type ArtifactCommitKind = z.infer<typeof artifactCommitKindSchema>;
export type ArtifactCommitCheckpoint = z.infer<typeof artifactCommitCheckpointSchema>;
export type DurableOperationKind = z.infer<typeof durableOperationKindSchema>;
export type DurableOperationCheckpoint = z.infer<typeof durableOperationCheckpointSchema>;
export type RuntimeStartCheckpoint = z.infer<typeof runtimeStartCheckpointSchema>;
export type RuntimeManifestRestartCheckpoint = z.infer<
  typeof runtimeManifestRestartCheckpointSchema
>;
export type AcceptanceLeaseDurableCheckpoint = z.infer<
  typeof acceptanceLeaseDurableCheckpointSchema
>;
export type LayeredArtifactPromotionCheckpoint = z.infer<
  typeof layeredArtifactPromotionCheckpointSchema
>;
export type ProductionDatabaseDurableCheckpoint = z.infer<
  typeof productionDatabaseDurableCheckpointSchema
>;
export type ArtifactCommitEventKind = z.infer<typeof artifactCommitEventKindSchema>;
export type ArtifactCommitEvent = z.infer<typeof artifactCommitEventSchema>;
export type ArtifactCommitDiagnosticsResponse = z.infer<
  typeof artifactCommitDiagnosticsResponseSchema
>;
export type DurableOperationDiscoveryRequest = z.infer<
  typeof durableOperationDiscoveryRequestSchema
>;
export type DurableOperationDiscoveryResponse = z.infer<
  typeof durableOperationDiscoveryResponseSchema
>;
export type RuntimeStartDiagnosticsResponse = z.infer<typeof runtimeStartDiagnosticsResponseSchema>;
export type RuntimeManifestRestartDiagnosticsResponse = z.infer<
  typeof runtimeManifestRestartDiagnosticsResponseSchema
>;
