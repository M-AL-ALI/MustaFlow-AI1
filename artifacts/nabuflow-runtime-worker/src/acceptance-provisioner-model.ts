import type {
  AcceptanceLeaseCreateRequest,
  AcceptanceLeaseOperation,
  AcceptanceLeaseResponse,
  AcceptanceLeaseScope,
  AcceptanceLeaseState,
  AcceptanceProvider,
  AcceptanceVerifyGoneResponse,
} from "@workspace/tenant-runtime-contracts";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import type { ControlDurableObject } from "./control-durable-object";
import type { AcceptanceVaultDurableObject } from "./acceptance-vault-durable-object";
import type { DurableOperationQueueMessage } from "./model";

export interface AcceptanceProvisionerVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface AcceptanceProvisionerBindings {
  ACCEPTANCE_VAULT: DurableObjectNamespace<AcceptanceVaultDurableObject>;
  ACCEPTANCE_COORDINATOR: DurableObjectNamespace<ControlDurableObject>;
  ACCEPTANCE_OPERATION_QUEUE: Queue<AcceptanceQueueMessage>;
  DURABLE_OPERATION_QUEUE?: Queue<DurableOperationQueueMessage>;
  CAPABILITY_VAULT: DurableObjectNamespace<CapabilityVaultDurableObject>;
  CF_VERSION_METADATA: AcceptanceProvisionerVersionMetadata;
  ACCEPTANCE_VAULT_KEK: string;
  ACCEPTANCE_NEON_MANAGEMENT_KEY?: string;
  ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY?: string;
  ACCEPTANCE_FLY_ORG_TOKEN?: string;
  ACCEPTANCE_WORKLOAD_PUBLIC_KEYS: string;
  ACCEPTANCE_WORKLOAD_ISSUER: string;
  ACCEPTANCE_WORKLOAD_AUDIENCE: string;
  ACCEPTANCE_WORKLOAD_SUBJECTS: string;
  ACCEPTANCE_NEON_ORGANIZATION_ID: string;
  ACCEPTANCE_STRIPE_SANDBOX_ID: string;
  ACCEPTANCE_FLY_ORGANIZATION_SLUG: string;
  ACCEPTANCE_FLY_IMAGE_REF: string;
  ACCEPTANCE_PROVIDER_MAX_COST_MINOR_UNITS: string;
  ACCEPTANCE_STAGING_ENABLED?: string;
}

export interface AcceptanceEncryptedMaterial {
  version: 1;
  keyId: "v1";
  nonce: string;
  ciphertext: string;
}

export interface AcceptanceLeaseResource {
  provider: AcceptanceProvider;
  ids: string[];
  createdByLease: true;
  configurationWritten: boolean;
}

export interface StoredAcceptanceLease {
  schemaVersion: 1;
  leaseId: string;
  identityHash: string;
  ownerSubjectHash: string;
  projectId: number;
  scope: AcceptanceLeaseScope;
  state: AcceptanceLeaseState;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  costCeilingMinorUnits: number;
  costAmountMinorUnits: number;
  resource: AcceptanceLeaseResource | null;
  material: AcceptanceEncryptedMaterial | null;
  capabilityRevision: string | null;
  terminalCode: string | null;
}

export interface AcceptanceLeaseAuditRecord {
  sequence: number;
  at: string;
  leaseId: string;
  provider: AcceptanceProvider;
  operation: AcceptanceLeaseOperation | "status" | "janitor";
  outcome: string;
  state: AcceptanceLeaseState;
  resourceCount: number;
  costAmountMinorUnits: number;
}

export interface AcceptanceVault {
  createLease(input: {
    leaseId: string;
    identityHash: string;
    ownerSubjectHash: string;
    request: AcceptanceLeaseCreateRequest;
    nowMs: number;
  }): Promise<
    | { state: "created"; lease: StoredAcceptanceLease }
    | { state: "exists"; lease: StoredAcceptanceLease }
    | { state: "conflict" }
  >;
  getAuthorizedLease(
    leaseId: string,
    ownerSubjectHash: string,
  ): Promise<StoredAcceptanceLease | null>;
  getLeaseForJanitor(leaseId: string): Promise<StoredAcceptanceLease | null>;
  listExpired(nowMs: number, limit: number): Promise<StoredAcceptanceLease[]>;
  listLeases(limit: number): Promise<StoredAcceptanceLease[]>;
  storeProviderResult(input: {
    leaseId: string;
    ownerSubjectHash: string;
    resource: AcceptanceLeaseResource;
    material: { kind: "neon-connection-string"; value: string } | null;
    costAmountMinorUnits: number;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null>;
  readMaterial(input: {
    leaseId: string;
    ownerSubjectHash: string;
    kind: "neon-connection-string";
  }): Promise<string | null>;
  markCapabilityProvisioned(input: {
    leaseId: string;
    ownerSubjectHash: string;
    revision: string;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null>;
  markFlySecretProvisioned(input: {
    leaseId: string;
    ownerSubjectHash: string;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null>;
  markDestroying(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null>;
  markDestroyed(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null>;
  markFailed(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    code: string;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null>;
  recordAudit(record: Omit<AcceptanceLeaseAuditRecord, "sequence">): Promise<void>;
  listAudit(): Promise<AcceptanceLeaseAuditRecord[]>;
}

export interface AcceptanceProviderCreateResult {
  resource: AcceptanceLeaseResource;
  material: { kind: "neon-connection-string"; value: string } | null;
  costAmountMinorUnits: number;
}

export interface AcceptanceProviderGoneResult {
  resourcesGone: boolean;
  configurationGone: boolean;
  costAmountMinorUnits: number;
}

export interface AcceptanceProviderAdapters {
  create(lease: StoredAcceptanceLease): Promise<AcceptanceProviderCreateResult>;
  writeFlyDatabaseUrl(lease: StoredAcceptanceLease, databaseUrl: string): Promise<void>;
  destroy(lease: StoredAcceptanceLease): Promise<void>;
  verifyGone(lease: StoredAcceptanceLease): Promise<AcceptanceProviderGoneResult>;
  reconcile(
    leases: StoredAcceptanceLease[],
    nowMs: number,
  ): Promise<{
    inspected: number;
    reclaimed: number;
  }>;
}

export interface AcceptanceWorkloadIdentity {
  subject: string;
  subjectHash: string;
  tokenId: string;
  expiresAtMs: number;
}

export interface AcceptanceWorkloadVerifier {
  verify(request: Request, nowMs: number): Promise<AcceptanceWorkloadIdentity | null>;
}

export type AcceptanceQueueMessage =
  | DurableOperationQueueMessage
  | { schemaVersion: 1; kind: "acceptance-janitor"; leaseId: string };

export interface AcceptanceLeaseOperationResult {
  response: AcceptanceLeaseResponse | AcceptanceVerifyGoneResponse;
  status: 200 | 201;
}
