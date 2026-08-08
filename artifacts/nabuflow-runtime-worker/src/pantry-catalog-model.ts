import type {
  PantryCatalogObjectReference,
  PantryCatalogShelfRecord,
  PantryCatalogStockRequest,
  PantryErrorCode,
  PantryRevisionState,
} from "@workspace/tenant-runtime-contracts";
import type { PantryCatalogDurableObject } from "./pantry-catalog-durable-object";

export interface PantryStockQueueMessage {
  schemaVersion: 1;
  assemblyId: string;
  requestSha256: string;
}

export interface PantryIngestFailureRecord {
  code: PantryErrorCode;
  message: string;
  retryable: boolean;
  failedAt: string;
  negativeCacheUntil: string;
}

export interface PantryIngestProgress {
  state: "queued" | "running" | "failed";
  attempt: number;
  updatedAt: string;
  leaseUntil: string | null;
  failure: PantryIngestFailureRecord | null;
}

export interface StoredPantryAssembly {
  assemblyId: string;
  request: PantryCatalogStockRequest;
  state: "assembling";
  objects: PantryCatalogObjectReference[];
  expiresAtMs: number;
  queueDeliveries: number;
  ingest?: PantryIngestProgress;
}

export type PantryStockLookup =
  | { state: "created"; assembly: StoredPantryAssembly }
  | { state: "assembling"; assembly: StoredPantryAssembly }
  | { state: "committed"; assemblyId: string; revisionRootSha256: string };

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
  | { state: "not_found" };

export interface PantryCatalogCoordinator {
  beginStock(request: PantryCatalogStockRequest): Promise<PantryStockLookup>;
  markQueueDelivery(assemblyId: string): Promise<"recorded" | "not_found">;
  claimIngest(assemblyId: string, now: string, leaseUntil: string): Promise<PantryIngestClaim>;
  recordIngestFailure(
    assemblyId: string,
    failure: PantryIngestFailureRecord,
  ): Promise<"recorded" | "not_found">;
  allocateRevisionIdentity(
    date: string,
  ): Promise<{ revisionId: string; parentRootSha256: string | null }>;
  getAssembly(assemblyId: string): Promise<StoredPantryAssembly | null>;
  recordStagedObject(
    assemblyId: string,
    reference: PantryCatalogObjectReference,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict">;
  commitShelf(
    assemblyId: string,
    shelf: PantryCatalogShelfRecord,
  ): Promise<"committed" | "replay" | "not_found" | "incomplete" | "conflict">;
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
