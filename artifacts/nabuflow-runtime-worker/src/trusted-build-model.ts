import {
  ZERO_GENERATION_ASSEMBLY_RESERVE_MS,
  type PantryErrorCode,
  type TrustedBuildAttemptEvidence,
  type TrustedBuildCollectionProgress,
  type TrustedBuildCommandDiagnostics,
  type TrustedBuildMemoryProgress,
  type TrustedBuildOutput,
  type TrustedBuildRequest,
  type TrustedBuildSecretScanFinding,
  type TrustedBuildSecretScanSummary,
  type TrustedBuildStage,
  type TrustedBuildState,
  type TrustedBuildVerificationProgress,
} from "@workspace/tenant-runtime-contracts";
import type { Sandbox } from "@cloudflare/sandbox";
import type { TrustedBuildDurableObject } from "./trusted-build-durable-object";

export const TRUSTED_BUILD_MAX_ATTEMPTS = 3;
export const TRUSTED_BUILD_QUEUE_WATCHDOG_MS = 60_000;
/**
 * The coordinator owns an absolute build deadline that no request, lease, or
 * consumer heartbeat can extend.  The remaining minute belongs to the kitchen
 * so it can observe and surface the coordinator's durable typed terminal.
 */
export const TRUSTED_BUILD_OPERATION_BOUND_MS = 1_080_000;
export const TRUSTED_BUILD_TERMINAL_OBSERVATION_MARGIN_MS = 60_000;

if (
  TRUSTED_BUILD_OPERATION_BOUND_MS + TRUSTED_BUILD_TERMINAL_OBSERVATION_MARGIN_MS >
  ZERO_GENERATION_ASSEMBLY_RESERVE_MS
) {
  throw new Error("Trusted build deadline exceeds the kitchen assembly reserve");
}

export interface TrustedBuildQueueMessage {
  schemaVersion: 1;
  buildId: string;
  requestId: string;
  requestSha256: string;
}

export interface TrustedBuildFailure {
  code: PantryErrorCode;
  message: string;
  retryable: boolean;
  status: number;
  failedAt: string;
  negativeCacheUntil: string;
}

export interface StoredTrustedBuild {
  buildId: string;
  requestId: string;
  requestSha256: string;
  state: TrustedBuildState;
  attempt: number;
  queueDeliveries: number;
  createdAt: string;
  /** Persisted for new builds; legacy records derive the same value from createdAt. */
  deadlineAt?: string;
  updatedAt: string;
  leaseUntil: string | null;
  cellId: string | null;
  requestObjectSha256: string;
  sourceObjectSha256: string;
  sourceBytes: number;
  outputObjectSha256: string | null;
  failure: TrustedBuildFailure | null;
  attempts: TrustedBuildAttemptEvidence[];
}

export type TrustedBuildBegin =
  | { state: "created"; build: StoredTrustedBuild }
  | { state: "coalesced" | "succeeded"; build: StoredTrustedBuild }
  | { state: "backpressure" };

export type TrustedBuildClaim =
  | { state: "claimed"; build: StoredTrustedBuild }
  | { state: "busy" | "terminal"; build: StoredTrustedBuild }
  | { state: "not_found" };

export interface TrustedBuildDiagnostics {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  queueDeliveries: number;
  coalescedRequests: number;
}

export interface TrustedBuildCoordinator {
  begin(
    request: Pick<
      StoredTrustedBuild,
      | "buildId"
      | "requestId"
      | "requestSha256"
      | "createdAt"
      | "updatedAt"
      | "requestObjectSha256"
      | "sourceObjectSha256"
      | "sourceBytes"
    >,
    maxActive: number,
  ): Promise<TrustedBuildBegin>;
  recordQueueDelivery(buildId: string): Promise<"recorded" | "not_found">;
  recordStage(
    buildId: string,
    attempt: number,
    pass: 1 | 2 | null,
    stage: TrustedBuildStage,
    outcome: "started" | "succeeded" | "failed",
  ): Promise<"recorded" | "not_found">;
  recordCollectionProgress(
    buildId: string,
    attempt: number,
    progress: TrustedBuildCollectionProgress,
  ): Promise<"recorded" | "not_found">;
  recordSecretScanFindings(
    buildId: string,
    attempt: number,
    findings: ReadonlyArray<TrustedBuildSecretScanFinding>,
  ): Promise<"recorded" | "not_found">;
  recordSecretScanSummary(
    buildId: string,
    attempt: number,
    summary: TrustedBuildSecretScanSummary,
  ): Promise<"recorded" | "not_found">;
  recordMemoryProgress(
    buildId: string,
    attempt: number,
    progress: TrustedBuildMemoryProgress,
  ): Promise<"recorded" | "not_found">;
  recordVerificationProgress(
    buildId: string,
    attempt: number,
    progress: TrustedBuildVerificationProgress,
  ): Promise<"recorded" | "not_found">;
  recordAttemptFailure(
    buildId: string,
    attempt: number,
    pass: 1 | 2 | null,
    stage: TrustedBuildStage,
    failure: Pick<TrustedBuildFailure, "code" | "message" | "retryable" | "status">,
    diagnostics: TrustedBuildCommandDiagnostics | null,
  ): Promise<"recorded" | "not_found">;
  claim(buildId: string, now: string, leaseUntil: string): Promise<TrustedBuildClaim>;
  renewLease(
    buildId: string,
    attempt: number,
    now: string,
    leaseUntil: string,
  ): Promise<"updated" | "not_found" | "stale" | "terminal">;
  bindCell(
    buildId: string,
    attempt: number,
    cellId: string | null,
  ): Promise<"updated" | "not_found" | "stale" | "terminal">;
  transition(
    buildId: string,
    attempt: number,
    expected: TrustedBuildState,
    next: "resolving" | "building" | "verifying",
    now: string,
  ): Promise<"updated" | "not_found" | "conflict" | "cancelled">;
  succeed(
    buildId: string,
    attempt: number,
    outputObjectSha256: string,
    now: string,
  ): Promise<"updated" | "not_found" | "conflict" | "cancelled">;
  requeue(
    buildId: string,
    attempt: number,
    expected: TrustedBuildState,
    now: string,
  ): Promise<"updated" | "not_found" | "conflict" | "cancelled">;
  fail(
    buildId: string,
    attempt: number,
    failure: TrustedBuildFailure,
  ): Promise<"updated" | "not_found" | "cancelled" | "stale">;
  cancel(buildId: string, now: string): Promise<"cancelled" | "already-terminal" | "not_found">;
  get(buildId: string): Promise<StoredTrustedBuild | null>;
  cleanup(
    olderThanMs: number,
    maxDeletes: number,
    includeSucceeded: boolean,
  ): Promise<StoredTrustedBuild[]>;
  diagnostics(): Promise<TrustedBuildDiagnostics>;
}

export interface TrustedBuildWorkerBindings {
  PANTRY_CATALOG: Fetcher;
  TRUSTED_BUILD_OBJECTS: R2Bucket;
  TRUSTED_BUILD_QUEUE?: Queue<TrustedBuildQueueMessage>;
  TRUSTED_BUILD_COORDINATOR: DurableObjectNamespace<TrustedBuildDurableObject>;
  TRUSTED_BUILD_SANDBOX: DurableObjectNamespace<Sandbox<TrustedBuildWorkerBindings>>;
  TRUSTED_BUILD_PLATFORM: string;
  TRUSTED_BUILD_SIGNING_KEY_ID: string;
  TRUSTED_BUILD_SIGNING_PRIVATE_KEY: string;
  TRUSTED_BUILD_PUBLIC_KEYS: string;
  TRUSTED_BUILD_MAX_ACTIVE?: string;
  /** Staging-only live recovery probe. No production configuration may set this flag. */
  TRUSTED_BUILD_STAGING_LIVE_RECOVERY_PROBE?: string;
}

export interface TrustedBuildCellFile {
  path: string;
  mode: 0o644 | 0o755;
  bytes: Uint8Array;
}

export interface TrustedBuildCellInput {
  request: TrustedBuildRequestMetadata;
  source: { objectKey: string; sha256: string; bytes: number };
  attempt: number;
  roots: ReadonlyArray<{ name: string; version: string }>;
  packageTarballs: ReadonlyArray<{
    name: string;
    version: string;
    sha256: string;
    integrity: string;
    bins: Readonly<Record<string, string>>;
    dependencies: ReadonlyArray<{
      name: string;
      version: string;
      kind: "runtime" | "optional" | "peer";
    }>;
    lifecycleScripts: "absent" | "disabled" | "isolated-passed" | "isolated-failed";
    bytes: number;
  }>;
  capturedResources: ReadonlyArray<{
    url: string;
    sha256: string;
    mediaType: string;
    bytes: number;
  }>;
  shelfContentSha256: ReadonlySet<string>;
}

export type TrustedBuildRequestMetadata = Omit<TrustedBuildRequest, "source"> & {
  source: { manifest: TrustedBuildRequest["source"]["manifest"] };
};

export interface TrustedBuildCellManifestFile {
  path: string;
  mode: 0o644 | 0o755;
  size: number;
  offset: number;
  sha256: string;
}

export interface TrustedBuildCellOutputChunk {
  index: number;
  sha256: string;
  bytes: number;
  stagingKey: string;
}

export interface TrustedBuildCellCollection {
  payloadBytes: number;
  payloadSha256: string;
  determinismManifestSha256: string;
  files: TrustedBuildCellManifestFile[];
  outputChunks: TrustedBuildCellOutputChunk[];
  scannedFiles: number;
  shelfExemptFiles: number;
  bytesScanned: number;
  peakBufferedBytes: number;
}

export interface TrustedBuildCellResult {
  app: TrustedBuildCellCollection;
  dependencies: TrustedBuildCellCollection;
  lifecycleScriptsExecuted: number;
  processPeak: number;
  elapsedMs: number;
}

export interface TrustedBuildCell {
  build(
    input: TrustedBuildCellInput,
    pass: 1 | 2,
    onStage?: (
      stage: TrustedBuildStage,
      outcome: "started" | "succeeded" | "failed",
    ) => Promise<void>,
    onCollectionProgress?: (progress: TrustedBuildCollectionProgress) => Promise<void>,
    onMemoryProgress?: (progress: TrustedBuildMemoryProgress) => Promise<void>,
  ): Promise<TrustedBuildCellResult>;
  destroy(): Promise<void>;
}

export interface TrustedBuildExecutionResult {
  output: TrustedBuildOutput;
  outputBytes: Uint8Array;
}
