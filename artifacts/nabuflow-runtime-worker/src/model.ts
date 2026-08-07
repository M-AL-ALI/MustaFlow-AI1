import type {
  CapabilityDefinition,
  CapabilityDatabaseResponse,
  CapabilityEchoResponse,
  CapabilityInvocation,
  LogsRuntimeResponse,
  RouteRecord,
  RuntimeDescriptor,
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
  deleteRuntime(identity: string): Promise<void>;
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
  | { state: "success"; response: CapabilityEchoResponse | CapabilityDatabaseResponse }
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
}
