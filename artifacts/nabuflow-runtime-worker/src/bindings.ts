import type { Sandbox } from "@cloudflare/sandbox";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import type { ControlDurableObject } from "./control-durable-object";

export interface WorkerVersionMetadataBinding {
  id: string;
  tag: string;
  timestamp: string;
}

export interface WorkerBindings {
  NABUFLOW_RUNTIME_ARTIFACTS: R2Bucket;
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
  NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED?: string;
  NABUFLOW_STAGING_WORKER_HOST?: string;
}
