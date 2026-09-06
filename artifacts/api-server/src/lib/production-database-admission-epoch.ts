import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  CONTROL_API_PREFIX,
  PRODUCTION_DATABASE_ADMISSION_EPOCH_BINDING,
  PRODUCTION_DATABASE_ADMISSION_FEATURE,
  sha256Hex,
  signControlRequest,
  versionResponseSchema,
} from "@workspace/tenant-runtime-contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_RESPONSE_LIMIT_BYTES = 65_536;
const CONTROL_TIMEOUT_MS = 10_000;
const CONTROL_CLOCK_SKEW_MS = 60_000;
export const PRODUCTION_DATABASE_ADMISSION_DRAIN_MS = 6 * 60 * 1_000;

type EpochState = "prepared" | "active" | "closed";
type EpochRow = {
  epoch: string;
  state: EpochState;
  worker_deployment_version: string;
  evidence_sha256: string;
  observed_at: Date | string;
  activated_at: Date | string | null;
  project_id_floor: number;
};

export type ProductionDatabaseAdmissionEpochStatus = Readonly<{
  configuredEpoch: string | null;
  phase: "unconfigured" | "missing" | EpochState;
  activeEpoch: string | null;
  workerDeploymentVersion: string | null;
  evidenceSha256: string | null;
  observedAt: string | null;
  readyAt: string | null;
  activatedAt: string | null;
  projectIdFloor: number | null;
  canActivate: boolean;
}>;

export class ProductionDatabaseAdmissionEpochError extends Error {
  readonly name = "ProductionDatabaseAdmissionEpochError";

  constructor(
    readonly code:
      | "production_database_admission_epoch_unconfigured"
      | "production_database_admission_control_unavailable"
      | "production_database_admission_control_feature_unavailable"
      | "production_database_admission_epoch_ledger_invalid"
      | "production_database_admission_epoch_closed"
      | "production_database_admission_epoch_not_prepared"
      | "production_database_admission_epoch_drain_incomplete"
      | "production_database_admission_worker_changed"
      | "production_database_admission_sequence_unavailable"
      | "production_database_admission_epoch_transition_conflict",
    readonly retryable = false,
  ) {
    super(code);
  }
}

type Dependencies = Readonly<{
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  uuid?: () => string;
}>;

function configuredEpoch(env: NodeJS.ProcessEnv): string | null {
  const value = env[PRODUCTION_DATABASE_ADMISSION_EPOCH_BINDING]?.trim().toLowerCase();
  return value && UUID.test(value) ? value : null;
}

function dateValue(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ProductionDatabaseAdmissionEpochError(
      "production_database_admission_epoch_ledger_invalid",
    );
  }
  return parsed;
}

function statusFromRow(
  epoch: string,
  row: EpochRow | undefined,
  activeEpoch: string | null,
  now: Date,
): ProductionDatabaseAdmissionEpochStatus {
  if (!row) {
    return {
      configuredEpoch: epoch,
      phase: "missing",
      activeEpoch,
      workerDeploymentVersion: null,
      evidenceSha256: null,
      observedAt: null,
      readyAt: null,
      activatedAt: null,
      projectIdFloor: null,
      canActivate: false,
    };
  }
  const observedAt = dateValue(row.observed_at);
  const activatedAt = dateValue(row.activated_at);
  if (!observedAt || !UUID.test(row.epoch) || !Number.isSafeInteger(Number(row.project_id_floor))) {
    throw new ProductionDatabaseAdmissionEpochError(
      "production_database_admission_epoch_ledger_invalid",
    );
  }
  const readyAt = new Date(observedAt.getTime() + PRODUCTION_DATABASE_ADMISSION_DRAIN_MS);
  return {
    configuredEpoch: epoch,
    phase: row.state,
    activeEpoch,
    workerDeploymentVersion: row.worker_deployment_version,
    evidenceSha256: row.evidence_sha256,
    observedAt: observedAt.toISOString(),
    readyAt: readyAt.toISOString(),
    activatedAt: activatedAt?.toISOString() ?? null,
    projectIdFloor: Number(row.project_id_floor),
    canActivate: row.state === "prepared" && now.getTime() >= readyAt.getTime(),
  };
}

async function selectEpoch(client: PoolClient, epoch: string, forUpdate = false) {
  const result = await client.query<EpochRow>(
    `SELECT epoch::text, state, worker_deployment_version, evidence_sha256,
            observed_at, activated_at, project_id_floor
       FROM public.production_database_admission_epochs
      WHERE epoch = $1::uuid${forUpdate ? " FOR UPDATE" : ""}`,
    [epoch],
  );
  if (result.rows.length > 1) {
    throw new ProductionDatabaseAdmissionEpochError(
      "production_database_admission_epoch_ledger_invalid",
    );
  }
  return result.rows[0];
}

async function selectActiveEpoch(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ epoch: string }>(
    `SELECT epoch::text FROM public.production_database_admission_epochs
      WHERE namespace = 'production' AND state = 'active'`,
  );
  if (result.rows.length > 1) {
    throw new ProductionDatabaseAdmissionEpochError(
      "production_database_admission_epoch_ledger_invalid",
    );
  }
  return result.rows[0]?.epoch.toLowerCase() ?? null;
}

async function transaction<T>(
  pool: Pick<Pool, "connect">,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await action(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createProductionDatabaseAdmissionEpochCoordinator(
  pool: Pick<Pool, "connect">,
  dependencies: Dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;

  async function probeWorker(): Promise<string> {
    const controlUrl = env.CLOUDFLARE_RUNTIME_CONTROL_URL?.trim();
    const controlToken = env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN?.trim();
    let target: URL;
    try {
      target = new URL(`${controlUrl?.replace(/\/+$/u, "")}${CONTROL_API_PREFIX}/version`);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        !controlToken ||
        Buffer.byteLength(controlToken, "utf8") < 32
      ) {
        throw new Error();
      }
    } catch {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_control_unavailable",
        true,
      );
    }
    let clockOffsetMs: number;
    try {
      const clockResponse = await fetcher(target, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });
      const workerDate = clockResponse.headers.get("date");
      const workerTime = workerDate === null ? Number.NaN : Date.parse(workerDate);
      clockOffsetMs = workerTime - now().getTime();
      await clockResponse.body?.cancel().catch(() => undefined);
      if (
        clockResponse.status >= 500 ||
        !Number.isFinite(workerTime) ||
        Math.abs(clockOffsetMs) > CONTROL_CLOCK_SKEW_MS
      ) {
        throw new Error();
      }
    } catch {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_control_unavailable",
        true,
      );
    }
    let response: Response;
    try {
      const timestamp = String(now().getTime() + clockOffsetMs);
      const nonce = uuid();
      const bodySha256 = await sha256Hex("");
      const signature = await signControlRequest(controlToken, {
        method: "GET",
        pathAndQuery: `${CONTROL_API_PREFIX}/version`,
        timestamp,
        nonce,
        bodySha256,
        idempotencyKey: "",
      });
      response = await fetcher(target, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        headers: {
          "x-nabuflow-timestamp": timestamp,
          "x-nabuflow-nonce": nonce,
          "x-nabuflow-body-sha256": bodySha256,
          "x-nabuflow-signature": signature,
        },
      });
    } catch {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_control_unavailable",
        true,
      );
    }
    const text = await response.text();
    if (!response.ok || Buffer.byteLength(text, "utf8") > CONTROL_RESPONSE_LIMIT_BYTES) {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_control_unavailable",
        response.status >= 500,
      );
    }
    let parsed: ReturnType<typeof versionResponseSchema.parse>;
    try {
      parsed = versionResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_control_unavailable",
        true,
      );
    }
    if (
      !parsed.features.includes("production-database-v1") ||
      !parsed.features.includes(PRODUCTION_DATABASE_ADMISSION_FEATURE)
    ) {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_control_feature_unavailable",
      );
    }
    return parsed.deploymentVersion;
  }

  async function status(): Promise<ProductionDatabaseAdmissionEpochStatus> {
    const epoch = configuredEpoch(env);
    if (!epoch) {
      return {
        configuredEpoch: null,
        phase: "unconfigured",
        activeEpoch: null,
        workerDeploymentVersion: null,
        evidenceSha256: null,
        observedAt: null,
        readyAt: null,
        activatedAt: null,
        projectIdFloor: null,
        canActivate: false,
      };
    }
    const client = await pool.connect();
    try {
      const [row, activeEpoch] = await Promise.all([
        selectEpoch(client, epoch),
        selectActiveEpoch(client),
      ]);
      return statusFromRow(epoch, row, activeEpoch, now());
    } finally {
      client.release();
    }
  }

  async function prepare(): Promise<ProductionDatabaseAdmissionEpochStatus> {
    const epoch = configuredEpoch(env);
    if (!epoch) {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_epoch_unconfigured",
      );
    }
    const workerDeploymentVersion = await probeWorker();
    return transaction(pool, async (client) => {
      await client.query(
        "LOCK TABLE public.production_database_admission_epochs IN SHARE ROW EXCLUSIVE MODE",
      );
      const existing = await selectEpoch(client, epoch, true);
      if (existing?.state === "closed") {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_epoch_closed",
        );
      }
      if (existing?.state === "active") {
        return statusFromRow(epoch, existing, epoch, now());
      }
      const floorResult = await client.query<{ floor: number | string }>(
        "SELECT COALESCE(MAX(id), 0)::bigint AS floor FROM public.projects",
      );
      const floor = Number(floorResult.rows[0]?.floor);
      if (!Number.isSafeInteger(floor) || floor < 0) {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_sequence_unavailable",
          true,
        );
      }
      if (existing?.worker_deployment_version === workerDeploymentVersion) {
        return statusFromRow(epoch, existing, await selectActiveEpoch(client), now());
      }
      const evidenceSha256 = await sha256Hex(
        JSON.stringify({
          semantics: "production-database-admission-epoch-prepare-v1",
          epoch,
          workerDeploymentVersion,
          projectIdFloor: floor,
        }),
      );
      const result = existing
        ? await client.query<EpochRow>(
            `UPDATE public.production_database_admission_epochs
                SET worker_deployment_version = $2, evidence_sha256 = $3,
                    observed_at = clock_timestamp(), activated_at = NULL,
                    project_id_floor = $4
              WHERE epoch = $1::uuid AND state = 'prepared'
          RETURNING epoch::text, state, worker_deployment_version, evidence_sha256,
                    observed_at, activated_at, project_id_floor`,
            [epoch, workerDeploymentVersion, evidenceSha256, floor],
          )
        : await client.query<EpochRow>(
            `INSERT INTO public.production_database_admission_epochs
              (epoch, namespace, state, worker_deployment_version, evidence_sha256,
               observed_at, activated_at, project_id_floor)
             VALUES ($1::uuid, 'production', 'prepared', $2, $3,
                     clock_timestamp(), NULL, $4)
          RETURNING epoch::text, state, worker_deployment_version, evidence_sha256,
                    observed_at, activated_at, project_id_floor`,
            [epoch, workerDeploymentVersion, evidenceSha256, floor],
          );
      const row = result.rows[0];
      if (!row) {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_epoch_transition_conflict",
        );
      }
      return statusFromRow(epoch, row, await selectActiveEpoch(client), now());
    });
  }

  async function activate(): Promise<ProductionDatabaseAdmissionEpochStatus> {
    const epoch = configuredEpoch(env);
    if (!epoch) {
      throw new ProductionDatabaseAdmissionEpochError(
        "production_database_admission_epoch_unconfigured",
      );
    }
    const workerDeploymentVersion = await probeWorker();
    return transaction(pool, async (client) => {
      // The project lock excludes inserts while the sequence floor and active
      // epoch become authoritative in the same transaction.
      await client.query("LOCK TABLE public.projects IN SHARE ROW EXCLUSIVE MODE");
      await client.query(
        "LOCK TABLE public.production_database_admission_epochs IN SHARE ROW EXCLUSIVE MODE",
      );
      const existing = await selectEpoch(client, epoch, true);
      if (existing?.state === "active") {
        return statusFromRow(epoch, existing, epoch, now());
      }
      if (!existing || existing.state !== "prepared") {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_epoch_not_prepared",
        );
      }
      if (existing.worker_deployment_version !== workerDeploymentVersion) {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_worker_changed",
        );
      }
      const readiness = await client.query<{ ready: boolean }>(
        `SELECT clock_timestamp() >= observed_at + interval '6 minutes' AS ready
           FROM public.production_database_admission_epochs
          WHERE epoch = $1::uuid AND state = 'prepared'`,
        [epoch],
      );
      if (readiness.rows[0]?.ready !== true) {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_epoch_drain_incomplete",
        );
      }
      const sequence = await client.query<{ floor: number | string | null }>(
        `SELECT nextval(pg_get_serial_sequence('public.projects', 'id')::regclass)::bigint AS floor`,
      );
      const floor = Number(sequence.rows[0]?.floor);
      if (!Number.isSafeInteger(floor) || floor < 0 || floor > 2_147_483_647) {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_sequence_unavailable",
          true,
        );
      }
      const evidenceSha256 = await sha256Hex(
        JSON.stringify({
          semantics: "production-database-admission-epoch-activate-v1",
          epoch,
          workerDeploymentVersion,
          projectIdFloor: floor,
          preparedEvidenceSha256: existing.evidence_sha256,
        }),
      );
      await client.query(
        `UPDATE public.production_database_admission_epochs
            SET state = 'closed'
          WHERE namespace = 'production' AND state = 'active' AND epoch <> $1::uuid`,
        [epoch],
      );
      const result = await client.query<EpochRow>(
        `UPDATE public.production_database_admission_epochs
            SET state = 'active', worker_deployment_version = $2,
                evidence_sha256 = $3, activated_at = clock_timestamp(),
                project_id_floor = $4
          WHERE epoch = $1::uuid AND state = 'prepared'
            AND clock_timestamp() >= observed_at + interval '6 minutes'
      RETURNING epoch::text, state, worker_deployment_version, evidence_sha256,
                observed_at, activated_at, project_id_floor`,
        [epoch, workerDeploymentVersion, evidenceSha256, floor],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ProductionDatabaseAdmissionEpochError(
          "production_database_admission_epoch_transition_conflict",
        );
      }
      return statusFromRow(epoch, row, epoch, now());
    });
  }

  return { status, prepare, activate } as const;
}
