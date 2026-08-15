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
  RuntimeArtifactLayerContent,
  RuntimeLayeredArtifactEnvelope,
  RuntimeManifestContract,
  ArtifactCommitCheckpoint,
  ArtifactCommitEvent,
  ArtifactCommitKind,
  AcceptanceLeaseDurableCheckpoint,
  AcceptanceLeaseJobRequest,
  DurableOperationCheckpoint,
  DurableOperationKind,
  RuntimeManifestRestartCheckpoint,
  RuntimeStartCheckpoint,
  LayeredArtifactPromotionCheckpoint,
  PromoteRuntimeLayeredArtifactRequest,
  StartRuntimeRequest,
  UpdateRuntimeManifestRequest,
} from "@workspace/tenant-runtime-contracts";

export type RuntimeLogEntry = LogsRuntimeResponse["entries"][number];

export interface StoredRuntime {
  descriptor: RuntimeDescriptor;
  manifest: RuntimeManifestContract;
  artifactRevision: string | null;
  artifactSha256: string | null;
  artifactKind?: "v1" | "layers-v1" | null;
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

export interface StoredRuntimeLayer {
  content: RuntimeArtifactLayerContent;
  state: "pending" | "committed";
  receivedChunks: Array<string | null>;
  pendingArtifacts: string[];
  artifactReferences: string[];
}

export interface StoredRuntimeLayeredArtifact {
  runtimeIdentity: string;
  envelope: RuntimeLayeredArtifactEnvelope;
  state: "pending" | "committed";
  receivedAppChunks: Array<string | null>;
  expiresAtMs: number | null;
}

export interface RemovedRuntimeLayeredArtifact {
  artifact: StoredRuntimeLayeredArtifact;
  unreferencedLayers: StoredRuntimeLayer[];
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

export type {
  AcceptanceLeaseDurableCheckpoint,
  ArtifactCommitCheckpoint,
  ArtifactCommitKind,
  DurableOperationCheckpoint,
  DurableOperationKind,
  RuntimeManifestRestartCheckpoint,
  RuntimeStartCheckpoint,
  LayeredArtifactPromotionCheckpoint,
};

export interface DurableOperationQueueMessage {
  schemaVersion: 1;
  jobKey: string;
  runtimeIdentity: string;
  subjectKey: string;
  kind: DurableOperationKind;
}

export type ArtifactCommitQueueMessage = DurableOperationQueueMessage;

interface StoredDurableOperationJobBase {
  jobKey: string;
  kind: DurableOperationKind;
  runtimeIdentity: string;
  subjectKey: string;
  expectedDeploymentVersion: string;
  fingerprint: string;
  idempotencyStorageKey: string;
  state: "active" | "succeeded" | "failed";
  checkpoint: DurableOperationCheckpoint;
  ownerId: string | null;
  attempt: number;
  eventSequence: number;
  events: Array<
    Omit<ArtifactCommitEvent, "checkpoint"> & { checkpoint: DurableOperationCheckpoint }
  >;
  leaseUntilMs: number | null;
  abandonAtMs: number | null;
  deadlineMs: number;
  response?: StoredHttpResponse;
  /** Added after the first durable-job rollout; legacy jobs derive this from their deadline. */
  createdAtMs?: number;
  updatedAtMs: number;
}

export interface StoredArtifactCommitJob extends StoredDurableOperationJobBase {
  kind: ArtifactCommitKind;
  checkpoint: ArtifactCommitCheckpoint;
  sealedArtifactSha256: string;
  payloadContentSha256s?: string[];
}

export interface StoredRuntimeStartJob extends StoredDurableOperationJobBase {
  kind: "runtime-start";
  checkpoint: RuntimeStartCheckpoint;
  request: StartRuntimeRequest;
}

export interface StoredRuntimeManifestRestartJob extends StoredDurableOperationJobBase {
  kind: "runtime-manifest-restart";
  checkpoint: RuntimeManifestRestartCheckpoint;
  request: UpdateRuntimeManifestRequest;
  runtimeWasRunning?: boolean;
}

export interface StoredAcceptanceLeaseJob extends StoredDurableOperationJobBase {
  kind: "acceptance-lease";
  checkpoint: AcceptanceLeaseDurableCheckpoint;
  request: AcceptanceLeaseJobRequest;
}

export interface StoredLayeredArtifactPromotionJob extends StoredDurableOperationJobBase {
  kind: "layered-artifact-promotion";
  checkpoint: LayeredArtifactPromotionCheckpoint;
  request: PromoteRuntimeLayeredArtifactRequest;
}

export type StoredDurableOperationJob =
  | StoredArtifactCommitJob
  | StoredRuntimeStartJob
  | StoredRuntimeManifestRestartJob
  | StoredAcceptanceLeaseJob
  | StoredLayeredArtifactPromotionJob;

export type DurableOperationRegistration =
  | {
      key: string;
      fingerprint: string;
      kind: ArtifactCommitKind;
      runtimeIdentity: string;
      subjectKey: string;
      sealedArtifactSha256: string;
      expectedDeploymentVersion: string;
      nowMs: number;
    }
  | {
      key: string;
      fingerprint: string;
      kind: "runtime-start";
      runtimeIdentity: string;
      subjectKey: "start";
      request: StartRuntimeRequest;
      expectedDeploymentVersion: string;
      nowMs: number;
    }
  | {
      key: string;
      fingerprint: string;
      kind: "runtime-manifest-restart";
      runtimeIdentity: string;
      subjectKey: "manifest-restart";
      request: UpdateRuntimeManifestRequest;
      expectedDeploymentVersion: string;
      nowMs: number;
    }
  | {
      key: string;
      fingerprint: string;
      kind: "acceptance-lease";
      runtimeIdentity: string;
      subjectKey: string;
      request: AcceptanceLeaseJobRequest;
      expectedDeploymentVersion: string;
      nowMs: number;
    }
  | {
      key: string;
      fingerprint: string;
      kind: "layered-artifact-promotion";
      runtimeIdentity: string;
      subjectKey: string;
      request: PromoteRuntimeLayeredArtifactRequest;
      expectedDeploymentVersion: string;
      nowMs: number;
    };

export type DurableOperationClaim =
  | { state: "new"; job: StoredDurableOperationJob }
  | { state: "pending"; job?: StoredDurableOperationJob }
  | { state: "conflict" }
  | { state: "replay"; response: StoredHttpResponse };

export type DurableOperationDriverClaim =
  | { state: "claimed" | "adopted"; job: StoredDurableOperationJob }
  | { state: "busy"; job: StoredDurableOperationJob }
  | { state: "terminal"; job: StoredDurableOperationJob }
  | { state: "not_found" };

export type ArtifactCommitClaim = DurableOperationClaim;
export type ArtifactCommitDriverClaim = DurableOperationDriverClaim;

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
  registerDurableOperation(input: DurableOperationRegistration): Promise<DurableOperationClaim>;
  claimDurableOperationDriver(
    jobKey: string,
    ownerId: string,
    nowMs: number,
  ): Promise<DurableOperationDriverClaim>;
  getDurableOperation(jobKey: string): Promise<StoredDurableOperationJob | null>;
  getLatestDurableOperation(
    kind: DurableOperationKind,
    runtimeIdentity: string,
    subjectKey: string,
  ): Promise<StoredDurableOperationJob | null>;
  listRecentDurableOperations(input: {
    sinceMs: number;
    untilMs: number;
    limit: number;
    kind?: DurableOperationKind;
  }): Promise<StoredDurableOperationJob[]>;
  recordDurableOperationNudge(
    jobKey: string,
    nowMs: number,
  ): Promise<"recorded" | "not_found" | "terminal">;
  recordDurableOperationDeploymentObservation(
    jobKey: string,
    deploymentVersion: string,
    nowMs: number,
  ): Promise<"matched" | "deferred" | "not_found" | "terminal">;
  renewDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    nowMs: number,
  ): Promise<"renewed" | "not_owner" | "terminal">;
  checkpointDurableOperation(input: {
    jobKey: string;
    ownerId: string;
    ownerGeneration: number;
    checkpoint: DurableOperationCheckpoint;
    payloadContentSha256s?: string[];
    runtimeWasRunning?: boolean;
    nowMs: number;
  }): Promise<StoredDurableOperationJob>;
  completeDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<"completed" | "already_terminal" | "not_owner">;
  failDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<"completed" | "already_terminal" | "not_owner">;
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
  beginLayeredArtifact(
    record: StoredRuntimeLayeredArtifact,
  ): Promise<"created" | "exists" | "conflict">;
  getLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeLayeredArtifact | null>;
  getRuntimeLayer(contentSha256: string): Promise<StoredRuntimeLayer | null>;
  recordLayeredArtifactAppChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict">;
  recordRuntimeLayerChunk(
    identity: string,
    sealedArtifactSha256: string,
    contentSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict">;
  commitLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found" | "conflict">;
  removeLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<RemovedRuntimeLayeredArtifact | null>;
  listLayeredArtifacts(identity: string): Promise<StoredRuntimeLayeredArtifact[]>;
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
  }): Promise<"revoked" | "not_found" | "conflict" | "cleanup_unavailable">;
  invokeStripe(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult>;
}
