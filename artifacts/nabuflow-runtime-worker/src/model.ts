import type {
  CapabilityDefinition,
  CapabilityDatabaseResponse,
  CapabilityEchoResponse,
  CapabilityStripeResponse,
  CapabilityInvocation,
  LogsRuntimeResponse,
  RouteRecord,
  RuntimeDescriptor,
  RuntimeArtifactEnvelope,
  RuntimeManifestContract,
} from "@workspace/tenant-runtime-contracts";

export type RuntimeLogEntry = LogsRuntimeResponse["entries"][number];

export interface StoredRuntime {
  descriptor: RuntimeDescriptor;
  manifest: RuntimeManifestContract;
  artifactRevision: string | null;
  artifactSha256: string | null;
  processId: string | null;
  stdoutLength: number;
  stderrLength: number;
  nextLogSequence: number;
  logs: RuntimeLogEntry[];
}

export interface StoredRuntimeArtifact {
  runtimeIdentity: string;
  envelope: RuntimeArtifactEnvelope;
  state: "pending" | "committed";
  receivedChunks: Array<string | null>;
  expiresAtMs: number | null;
}

export interface StoredHttpResponse {
  status: number;
  body: unknown;
}

export type IdempotencyLookup =
  | { state: "new" }
  | { state: "pending" }
  | { state: "conflict" }
  | { state: "replay"; response: StoredHttpResponse };

export interface ControlAuditRecord {
  requestId: string;
  timestamp: string;
  method: string;
  endpoint: string;
  stage: string | null;
  outcome: string;
  projectId: number | null;
  role: string | null;
  slot: string | null;
  status: number;
  databaseSqlstate?: string;
}

export interface ControlCoordinator {
  consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean>;
  isConsumedOnce(nonce: string, nowMs: number): Promise<boolean>;
  beginIdempotency(key: string, fingerprint: string, nowMs: number): Promise<IdempotencyLookup>;
  completeIdempotency(
    key: string,
    fingerprint: string,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<void>;
  abandonIdempotency(key: string, fingerprint: string): Promise<void>;
  recordAudit(record: ControlAuditRecord): Promise<void>;
  getRuntime(identity: string): Promise<StoredRuntime | null>;
  putRuntime(identity: string, runtime: StoredRuntime): Promise<void>;
  putRuntimeIfManifestRevision(
    identity: string,
    expectedManifestRevision: string,
    runtime: StoredRuntime,
  ): Promise<"updated" | "not_found" | "conflict">;
  deleteRuntime(identity: string): Promise<void>;
  beginArtifact(record: StoredRuntimeArtifact): Promise<"created" | "exists" | "conflict">;
  getArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null>;
  recordArtifactChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict">;
  commitArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found">;
  removeArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null>;
  listArtifacts(identity: string): Promise<StoredRuntimeArtifact[]>;
  bindContainer(containerId: string, identity: string): Promise<void>;
  getContainerBinding(containerId: string): Promise<string | null>;
  unbindContainer(containerId: string, expectedIdentity: string): Promise<boolean>;
  getRoute(hostname: string): Promise<RouteRecord | null>;
  activateRoute(
    route: RouteRecord,
    expectedPreviousManifestRevision: string | null,
  ): Promise<"activated" | "conflict">;
  deactivateRoute(
    hostname: string,
    expectedManifestRevision: string,
    expectedSandboxIdentity: string,
  ): Promise<"deactivated" | "not_found" | "conflict">;
  appendSystemLog(identity: string, message: string): Promise<void>;
  mergeProcessLogs(identity: string, stdout: string, stderr: string): Promise<void>;
  listRuntimeLogs(
    identity: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: RuntimeLogEntry[]; nextCursor: string | null }>;
}

export type CapabilityVaultInvocationResult =
  | {
      state: "success";
      response: CapabilityEchoResponse | CapabilityDatabaseResponse | CapabilityStripeResponse;
    }
  | { state: "not_found" }
  | { state: "tenant_mismatch" }
  | { state: "policy_rejected" }
  | {
      state: "database_error";
      status: 400 | 409 | 502 | 503 | 504;
      code:
        | "database_invalid_query"
        | "database_constraint_violation"
        | "database_conflict"
        | "database_timeout"
        | "database_unavailable"
        | "database_execution_failed"
        | "database_response_too_large";
      retryable: boolean;
      sqlstate: string | null;
    }
  | {
      state: "stripe_error";
      status: 400 | 409 | 429 | 502 | 503 | 504;
      code:
        | "stripe_invalid_request"
        | "stripe_idempotency_conflict"
        | "stripe_rate_limited"
        | "stripe_timeout"
        | "stripe_unavailable"
        | "stripe_execution_failed";
      retryable: boolean;
    };

export interface CapabilityVault {
  provisionEcho(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
  }): Promise<{ state: "provisioned"; keyId: string }>;
  revokeEcho(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict">;
  invokeEcho(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult>;
  provisionDatabase(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    credential: { kind: "neon-connection-string"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }>;
  revokeDatabase(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict">;
  invokeDatabase(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult>;
  provisionStripe(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    policy: { allowedCurrencies: string[]; maxAmount: number };
    credential: { kind: "stripe-test-secret-key"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }>;
  revokeStripe(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict">;
  invokeStripe(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult>;
}
