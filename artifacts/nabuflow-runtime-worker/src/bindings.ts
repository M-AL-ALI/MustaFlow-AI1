import type { Sandbox } from "@cloudflare/sandbox";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import type { ControlDurableObject } from "./control-durable-object";
import type { DurableOperationQueueMessage } from "./model";

export interface WorkerVersionMetadataBinding {
  id: string;
  tag: string;
  timestamp: string;
}

export interface WorkerBindings {
  NABUFLOW_RUNTIME_ARTIFACTS: R2Bucket;
  DURABLE_OPERATION_QUEUE?: Queue<DurableOperationQueueMessage>;
  /** @deprecated Test-only compatibility alias; production uses DURABLE_OPERATION_QUEUE. */
  ARTIFACT_COMMIT_QUEUE?: Queue<DurableOperationQueueMessage>;
  PANTRY_CATALOG: Fetcher;
  TRUSTED_BUILD_PLANE?: Fetcher;
  CAPABILITY_VAULT: DurableObjectNamespace<CapabilityVaultDurableObject>;
  CONTROL_COORDINATOR: DurableObjectNamespace<ControlDurableObject>;
  NABUFLOW_SANDBOX: DurableObjectNamespace<Sandbox<WorkerBindings>>;
  CF_VERSION_METADATA: WorkerVersionMetadataBinding;
  CLOUDFLARE_RUNTIME_CONTROL_TOKEN: string;
  CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: string;
  CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: string;
  CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: string;
  NABUFLOW_RUNTIME_SLEEP_AFTER: string;
  NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID: string;
  NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED?: string;
  NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY?: string;
  NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID?: string;
  NABUFLOW_PRODUCTION_NEON_REGION_ID?: string;
  NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS?: string;
  NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS?: string;
  /** Staging-only, doubly locked rehearsal profile for fake/provider-controlled proofs. */
  NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL?: string;
  NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED?: string;
  NABUFLOW_STAGING_WORKER_HOST?: string;
  NABUFLOW_RUNTIME_LAYER_PLATFORM?: string;
  /** Staging-only fault injection for live coordinator-owned artifact commit recovery proofs. */
  NABUFLOW_STAGING_ARTIFACT_COMMIT_RECOVERY_PROBE?: string;
  /** Staging-only fault injection for live runtime lifecycle recovery proofs. */
  NABUFLOW_STAGING_RUNTIME_LIFECYCLE_RECOVERY_PROBE?: string;
}
