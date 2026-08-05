import type {
  LogsRuntimeResponse,
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
}

export interface ControlCoordinator {
  consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean>;
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
  appendSystemLog(identity: string, message: string): Promise<void>;
  mergeProcessLogs(identity: string, stdout: string, stderr: string): Promise<void>;
  listRuntimeLogs(
    identity: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: RuntimeLogEntry[]; nextCursor: string | null }>;
}
