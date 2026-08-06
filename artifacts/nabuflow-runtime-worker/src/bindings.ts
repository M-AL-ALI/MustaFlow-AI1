import type { Sandbox } from "@cloudflare/sandbox";
import type { ControlDurableObject } from "./control-durable-object";

export interface WorkerVersionMetadataBinding {
  id: string;
  tag: string;
  timestamp: string;
}

export interface WorkerBindings {
  CONTROL_COORDINATOR: DurableObjectNamespace<ControlDurableObject>;
  NABUFLOW_SANDBOX: DurableObjectNamespace<Sandbox<WorkerBindings>>;
  CF_VERSION_METADATA: WorkerVersionMetadataBinding;
  CLOUDFLARE_RUNTIME_CONTROL_TOKEN: string;
  CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: string;
  CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: string;
  NABUFLOW_RUNTIME_SLEEP_AFTER: string;
  NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED?: string;
  NABUFLOW_STAGING_WORKER_HOST?: string;
}
