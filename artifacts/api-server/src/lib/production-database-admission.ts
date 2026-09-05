import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  PRODUCTION_DATABASE_ADMISSION_EPOCH_BINDING,
  productionDatabaseAllocationIdentity,
  productionDatabaseAuthorizedAdmissionSchema,
  productionDatabaseSealedAdmissionSchema,
  sha256Hex,
  type ProductionDatabaseAdmissionReceipt,
} from "@workspace/tenant-runtime-contracts";
import {
  hasCurrentProjectRetirementCompletionEvidence,
  hasProjectRestoreReplayReceipt,
} from "./project-retirement-contract";

type AdmissionInput = {
  projectId: number;
  allocationIdentity: string;
  signal?: AbortSignal;
};
type AuthorizedReceipt = Extract<ProductionDatabaseAdmissionReceipt, { assertion: "authorized" }>;
type SealedReceipt = Extract<ProductionDatabaseAdmissionReceipt, { assertion: "sealed" }>;

export interface ProductionDatabaseAdmissionService {
  authorize(input: AdmissionInput): Promise<AuthorizedReceipt>;
  seal(input: AdmissionInput): Promise<SealedReceipt | null>;
}

type LedgerRow = {
  project_id: number;
  registration_epoch: string;
  birth_token: string;
  birth_registered: boolean;
  allocation_identity: string | null;
  state: "fresh" | "authorized" | "sealed";
  authorization_id: string | null;
  seal_id: string | null;
};

export class ProductionDatabaseAdmissionError extends Error {
  readonly retryable = false;

  constructor(readonly code: string) {
    super("Production database authorization could not be established safely.");
    this.name = "ProductionDatabaseAdmissionError";
  }
}

function reject(code: string): never {
  throw new ProductionDatabaseAdmissionError(code);
}

function receipt(row: LedgerRow, assertion: "authorized"): AuthorizedReceipt;
function receipt(row: LedgerRow, assertion: "sealed"): SealedReceipt;
function receipt(
  row: LedgerRow,
  assertion: "authorized" | "sealed",
): AuthorizedReceipt | SealedReceipt {
  const value = {
    format: "nabuflow.production-database-admission/v1",
    issuer: "nabuflow-api",
    audience: "production",
    projectId: row.project_id,
    allocationIdentity: row.allocation_identity,
    registrationEpoch: row.registration_epoch,
    birthToken: row.birth_token,
    receiptId: assertion === "sealed" ? row.seal_id : row.authorization_id,
    birthRegistered: row.birth_registered,
    assertion,
  };
  return assertion === "sealed"
    ? productionDatabaseSealedAdmissionSchema.parse(value)
    : productionDatabaseAuthorizedAdmissionSchema.parse(value);
}

/**
 * The project row serializes creation authorization with Trash and final purge.
 * An authorization is returned only after COMMIT; an interrupted caller never
 * gets authority by rolling a durable dispatch record back to "fresh".
 */
export function createProductionDatabaseAdmissionService(
  pool: Pick<Pool, "connect">,
  dependencies: { epoch?: () => string | undefined; uuid?: () => string } = {},
): ProductionDatabaseAdmissionService {
  const epoch =
    dependencies.epoch ?? (() => process.env[PRODUCTION_DATABASE_ADMISSION_EPOCH_BINDING]);
  const uuid = dependencies.uuid ?? randomUUID;

  async function transaction<T>(
    input: AdmissionInput,
    action: (client: PoolClient, registrationEpoch: string) => Promise<T>,
  ): Promise<T> {
    input.signal?.throwIfAborted();
    const expected = await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: input.projectId,
    });
    if (expected !== input.allocationIdentity)
      reject("production_database_admission_identity_mismatch");
    const registrationEpoch = epoch();
    if (
      !registrationEpoch ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        registrationEpoch,
      )
    ) {
      reject("production_database_admission_epoch_unavailable");
    }
    input.signal?.throwIfAborted();
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      input.signal?.throwIfAborted();
      const result = await action(client, registrationEpoch.toLowerCase());
      input.signal?.throwIfAborted();
      await client.query("COMMIT");
      open = false;
      input.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (open) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function lockContext(client: PoolClient, input: AdmissionInput, registrationEpoch: string) {
    const projects = await client.query<{ id: number; deleted_at: Date | null }>(
      "SELECT id, deleted_at FROM public.projects WHERE id = $1 FOR UPDATE",
      [input.projectId],
    );
    const epochs = await client.query<{ epoch: string }>(
      `SELECT epoch FROM public.production_database_admission_epochs
       WHERE epoch = $1::uuid AND namespace = 'production' AND state = 'active'
         AND activated_at <= clock_timestamp()
       FOR SHARE`,
      [registrationEpoch],
    );
    if (epochs.rows.length !== 1) reject("production_database_admission_epoch_inactive");
    const records = await client.query<LedgerRow>(
      "SELECT * FROM public.production_database_admission_receipts WHERE project_id = $1 FOR UPDATE",
      [input.projectId],
    );
    const row = records.rows[0];
    if (
      row &&
      (row.registration_epoch !== registrationEpoch ||
        row.project_id !== input.projectId ||
        (row.allocation_identity !== null && row.allocation_identity !== input.allocationIdentity))
    ) {
      reject("production_database_admission_identity_mismatch");
    }
    input.signal?.throwIfAborted();
    return { project: projects.rows[0], row };
  }

  return {
    authorize: (input) =>
      transaction(input, async (client, registrationEpoch) => {
        const { project, row } = await lockContext(client, input, registrationEpoch);
        if (!project || project.deleted_at !== null)
          reject("production_database_admission_project_inactive");
        if (row?.state === "sealed") reject("production_database_admission_sealed");
        if (row?.state === "authorized") return receipt(row, "authorized");
        const authorizationId = uuid();
        const result = row
          ? await client.query<LedgerRow>(
              `UPDATE public.production_database_admission_receipts
             SET state = 'authorized', allocation_identity = $2, authorization_id = $3::uuid,
                 updated_at = clock_timestamp()
             WHERE project_id = $1 AND state = 'fresh' RETURNING *`,
              [input.projectId, input.allocationIdentity, authorizationId],
            )
          : await client.query<LedgerRow>(
              `INSERT INTO public.production_database_admission_receipts
             (project_id, registration_epoch, birth_token, birth_registered, allocation_identity,
              state, authorization_id)
             VALUES ($1, $2::uuid, $3::uuid, false, $4, 'authorized', $5::uuid) RETURNING *`,
              [
                input.projectId,
                registrationEpoch,
                uuid(),
                input.allocationIdentity,
                authorizationId,
              ],
            );
        if (result.rows.length !== 1) reject("production_database_admission_transition_conflict");
        return receipt(result.rows[0]!, "authorized");
      }),
    seal: (input) =>
      transaction(input, async (client, registrationEpoch) => {
        const { project, row } = await lockContext(client, input, registrationEpoch);
        // Only a durable terminal seal can be replayed after the project is gone.
        if (!project) {
          if (row?.state === "sealed") return receipt(row, "sealed");
          reject("production_database_admission_project_missing");
        }
        if (project.deleted_at === null)
          reject("production_database_admission_project_not_in_trash");
        const retirements = await client.query<{
          id: string;
          state: string;
          completed_at: Date | null;
          progress: unknown;
        }>(
          `SELECT id, state, completed_at, progress FROM public.project_retirement_operations
         WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1 FOR SHARE`,
          [input.projectId],
        );
        const retirement = retirements.rows[0];
        if (
          !retirement ||
          retirement.state !== "completed" ||
          !retirement.completed_at ||
          !hasCurrentProjectRetirementCompletionEvidence(retirement.progress) ||
          hasProjectRestoreReplayReceipt(retirement)
        ) {
          reject("production_database_admission_retirement_incomplete");
        }
        const retirementHash = await sha256Hex(retirement.id);
        const purges = await client.query<{ id: string }>(
          `SELECT id FROM public.project_purge_operations
         WHERE project_id = $1 AND state = 'running'
           AND lease_expires_at > clock_timestamp()
           AND retirement_operation_id_hash = $2 FOR SHARE`,
          [input.projectId, retirementHash],
        );
        if (purges.rows.length !== 1)
          reject("production_database_admission_purge_authority_missing");
        if (row?.state === "sealed") return receipt(row, "sealed");
        const sealId = uuid();
        const result = row
          ? await client.query<LedgerRow>(
              `UPDATE public.production_database_admission_receipts
             SET state = 'sealed', allocation_identity = $2, seal_id = $3::uuid,
                 updated_at = clock_timestamp()
             WHERE project_id = $1 AND state IN ('fresh', 'authorized') RETURNING *`,
              [input.projectId, input.allocationIdentity, sealId],
            )
          : await client.query<LedgerRow>(
              `INSERT INTO public.production_database_admission_receipts
             (project_id, registration_epoch, birth_token, birth_registered, allocation_identity,
              state, seal_id)
             VALUES ($1, $2::uuid, $3::uuid, false, $4, 'sealed', $5::uuid) RETURNING *`,
              [input.projectId, registrationEpoch, uuid(), input.allocationIdentity, sealId],
            );
        if (result.rows.length !== 1) reject("production_database_admission_transition_conflict");
        return receipt(result.rows[0]!, "sealed");
      }),
  };
}

let service: ProductionDatabaseAdmissionService | undefined;

export async function getProductionDatabaseAdmissionService(): Promise<ProductionDatabaseAdmissionService> {
  if (!service) {
    const { pool } = await import("@workspace/db");
    service = createProductionDatabaseAdmissionService(pool);
  }
  return service;
}
