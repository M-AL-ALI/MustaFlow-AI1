import type {
  PantryCatalogAssemblyDiagnosticsResponse,
  PantryCatalogAssemblyEventKind,
  PantryCatalogAssemblyProgressMetrics,
  PantryCatalogAssemblyStage,
  PantryCatalogObjectReference,
  PantryCatalogShelfRecord,
  PantryCatalogStockIdentityStatusResponse,
  PantryCatalogStockRequest,
  PantryErrorCode,
  PantryRevisionState,
} from "@workspace/tenant-runtime-contracts";
import type { PantryCatalogDurableObject } from "./pantry-catalog-durable-object";

export interface PantryStockQueueMessage {
  schemaVersion: 1;
  assemblyId: string;
  requestSha256: string;
  generation: number;
}

export interface PantryGenerationResourceEvidence {
  assemblyId: string;
  generation: number;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  outcome: "running" | "succeeded" | "failed";
  phase: string;
  trustedFetches: number;
  internalPantryCalls: number;
  durableObjectCalls: number;
  durableObjectCallsByMethod: Record<string, number>;
  r2Calls: number;
  r2CallsByMethod: Record<string, number>;
  r2Active: number;
  r2MaxConcurrency: number;
  verifiedResumedObjects: number;
  estimatedPlatformSubrequests: number;
  evidenceWrites: number;
}

export interface PantryIngestFailureRecord {
  code: PantryErrorCode;
  message: string;
  retryable: boolean;
  failedAt: string;
  negativeCacheUntil: string;
  stage:
    | "registry-ingest"
    | "stage-object"
    | "commit-shelf"
    | "lease-renewal"
    | "assembly-deadline";
  operation:
    | "registry-ingest"
    | "catalog-read-assembly"
    | "catalog-stage-object"
    | "catalog-record-object"
    | "catalog-build-shelf"
    | "catalog-read-existing-shelf"
    | "catalog-verify-existing-shelf"
    | "catalog-verify-quarantine"
    | "catalog-promote-cas"
    | "catalog-write-manifest"
    | "catalog-commit-ledger"
    | "catalog-delete-quarantine"
    | "lease-renewal"
    | "assembly-deadline";
  cause:
    | "registry-upstream"
    | "catalog-storage-limit"
    | "catalog-storage-rate-limited"
    | "catalog-storage-quota"
    | "catalog-storage-unavailable"
    | "catalog-binding-missing"
    | "catalog-owner-fenced"
    | "catalog-rejected"
    | "catalog-internal"
    | "executor-internal"
    | "executor-subrequest-limit"
    | "deadline-exceeded";
  errorClass:
    | "Error"
    | "TypeError"
    | "RangeError"
    | "DOMException"
    | "PantryHttpError"
    | "UnknownError"
    | null;
  errorCode: string | null;
  errorFingerprint: string | null;
}

export interface PantryIngestProgress {
  state: "queued" | "running" | "failed";
  attempt: number;
  updatedAt: string;
  leaseUntil: string | null;
  failure: PantryIngestFailureRecord | null;
}

export interface PantryAssemblyEventInput {
  kind: PantryCatalogAssemblyEventKind;
  stage: PantryCatalogAssemblyStage;
  at: string;
  generation?: number;
  attempt?: number;
  metrics?: PantryCatalogAssemblyProgressMetrics;
  failureCode?: PantryErrorCode | null;
  failureStage?: PantryIngestFailureRecord["stage"] | null;
  failureOperation?: PantryIngestFailureRecord["operation"] | null;
  failureCause?: PantryIngestFailureRecord["cause"] | null;
  failureErrorClass?: PantryIngestFailureRecord["errorClass"];
  failureErrorCode?: string | null;
  failureErrorFingerprint?: string | null;
  reclaimedObjects?: number;
  reclaimedBytes?: number;
}

export interface PantryAssemblyExecution {
  generation: number;
  state: "queued" | "running" | "failed";
  ownerId: string | null;
  leaseUntilMs: number | null;
  deadlineMs: number;
  nextDriveAtMs: number;
  enqueuedGeneration: number | null;
  checkpoint: "queued" | "ingesting" | "staging-objects" | "committing-shelf";
}

export interface StoredPantryAssembly {
  assemblyId: string;
  request: PantryCatalogStockRequest;
  state: "assembling";
  objects: PantryCatalogObjectReference[];
  expiresAtMs: number;
  queueDeliveries: number;
  ingest?: PantryIngestProgress;
  execution: PantryAssemblyExecution;
}

export type PantryStockLookup =
  | { state: "created"; assembly: StoredPantryAssembly }
  | { state: "adopted"; assembly: StoredPantryAssembly }
  | { state: "assembling"; assembly: StoredPantryAssembly }
  | { state: "committed"; assemblyId: string; revisionRootSha256: string }
  | { state: "conflict"; assemblyId: string };

export interface PantryShelfLookup {
  shelf: PantryCatalogShelfRecord;
  lifecycle: PantryRevisionState;
  externalReferences: number;
}

export interface RemovedPantryShelf {
  shelf: PantryCatalogShelfRecord;
  unreferencedObjectSha256: string[];
}

export interface PantryCatalogDiagnostics {
  assemblies: number;
  shelves: number;
  committedObjects: number;
  externalReferences: number;
  queueDeliveries: number;
  failedIngests: number;
}

export type PantryIngestClaim =
  | { state: "claimed"; assembly: StoredPantryAssembly }
  | { state: "busy" | "failed"; assembly: StoredPantryAssembly }
  | { state: "stale"; assembly: StoredPantryAssembly }
  | { state: "not_found" };

export interface PantryCatalogCoordinator {
  beginStock(request: PantryCatalogStockRequest): Promise<PantryStockLookup>;
  getStockIdentity(
    identitySha256: string,
  ): Promise<PantryCatalogStockIdentityStatusResponse | null>;
  markQueueDelivery(assemblyId: string): Promise<"recorded" | "not_found">;
  claimIngest(
    assemblyId: string,
    generation: number,
    ownerId: string,
    nowMs: number,
  ): Promise<PantryIngestClaim>;
  renewIngest(
    assemblyId: string,
    generation: number,
    ownerId: string,
    nowMs: number,
  ): Promise<"renewed" | "not_owner" | "terminal" | "not_found">;
  recordIngestFailure(
    assemblyId: string,
    generation: number,
    ownerId: string,
    failure: PantryIngestFailureRecord,
  ): Promise<"recorded" | "not_owner" | "not_found">;
  allocateRevisionIdentity(
    date: string,
  ): Promise<{ revisionId: string; parentRootSha256: string | null }>;
  getAssembly(assemblyId: string): Promise<StoredPantryAssembly | null>;
  getAssemblyDiagnostics(
    assemblyId: string,
  ): Promise<PantryCatalogAssemblyDiagnosticsResponse | null>;
  recordGenerationResourceEvidence(evidence: PantryGenerationResourceEvidence): Promise<void>;
  getGenerationResourceEvidence(assemblyId: string): Promise<PantryGenerationResourceEvidence[]>;
  recordR2ProbeCheckpoint(
    probeId: string,
    window: number,
    operation: number,
    checkpoint: {
      contentSha256: string;
      bytes: number;
      completedAt: string;
    },
  ): Promise<void>;
  clearR2ProbeCheckpoints(probeId: string): Promise<number>;
  recordAssemblyEvent(
    assemblyId: string,
    event: PantryAssemblyEventInput,
  ): Promise<"recorded" | "not_found">;
  recordStagedObject(
    assemblyId: string,
    reference: PantryCatalogObjectReference,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict">;
  reclaimAssemblyObjects(
    assemblyId: string,
  ): Promise<{ state: "reclaimed"; objects: number; bytes: number } | { state: "not_found" }>;
  isObjectReferenced(sha256: string, ignoredAssemblyId?: string): Promise<boolean>;
  commitShelf(
    assemblyId: string,
    shelf: PantryCatalogShelfRecord,
  ): Promise<"committed" | "replay" | "not_found" | "incomplete" | "conflict">;
  commitDerivedShelf(
    parentRootSha256: string,
    shelf: PantryCatalogShelfRecord,
  ): Promise<"committed" | "replay" | "not_found" | "conflict">;
  getShelfByRoot(rootSha256: string): Promise<PantryShelfLookup | null>;
  getShelfByRevisionId(revisionId: string): Promise<PantryShelfLookup | null>;
  transitionShelf(
    rootSha256: string,
    expectedStateRevision: number,
    nextState: "quarantined" | "retired",
    updatedAt: string,
  ): Promise<"updated" | "not_found" | "conflict">;
  retainShelf(
    rootSha256: string,
    referenceId: string,
  ): Promise<"retained" | "replay" | "not_found">;
  releaseShelf(rootSha256: string, referenceId: string): Promise<"released" | "not_found">;
  cleanupExpiredAssemblies(nowMs: number, maxDeletes: number): Promise<string[]>;
  collectRetiredShelf(
    rootSha256: string,
    retentionNamespace: string,
    nowMs: number,
  ): Promise<RemovedPantryShelf | "not_found" | "conflict">;
  diagnostics(): Promise<PantryCatalogDiagnostics>;
}

export interface PantryWorkerBindings {
  PANTRY_CATALOG_COORDINATOR: DurableObjectNamespace<PantryCatalogDurableObject>;
  PANTRY_CATALOG_OBJECTS: R2Bucket;
  PANTRY_INGEST_QUEUE?: Queue<PantryStockQueueMessage>;
  PANTRY_INGEST_SIGNING_KEY_ID?: string;
  PANTRY_INGEST_SIGNING_PRIVATE_KEY?: string;
}
