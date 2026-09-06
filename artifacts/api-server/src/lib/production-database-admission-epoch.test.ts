import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  verifyControlRequestSignature,
} from "@workspace/tenant-runtime-contracts";
import type { Pool, PoolClient } from "pg";
import {
  createProductionDatabaseAdmissionEpochCoordinator,
  ProductionDatabaseAdmissionEpochError,
} from "./production-database-admission-epoch";

const epoch = "71c079dd-caa9-4abd-b61e-84eac2d93260";
const workerVersion = "b1bd960c-ff39-460d-8bfa-5238202194fa";
const preparedRow = {
  epoch,
  state: "prepared" as const,
  worker_deployment_version: workerVersion,
  evidence_sha256: "a".repeat(64),
  observed_at: new Date("2026-09-06T15:00:00.000Z"),
  activated_at: null,
  project_id_floor: 96,
};

function workerResponse(now: string): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      deploymentVersion: workerVersion,
      provider: "cloudflare",
      supportedRoles: ["preview", "production"],
      features: ["production-database-v1", "production-database-admission-v1"],
    }),
    { status: 200, headers: { date: new Date(now).toUTCString() } },
  );
}

function sequencedPool(results: Array<unknown>) {
  let index = 0;
  const query = vi.fn(async (text: string) => {
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE)/u.test(text)) return { rows: [] };
    const rows = results[index++] ?? [];
    return { rows };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">;
  return { pool, query, release };
}

describe("production database admission epoch coordinator", () => {
  it("fails closed without a configured epoch and never opens the database", async () => {
    const { pool } = sequencedPool([]);
    const coordinator = createProductionDatabaseAdmissionEpochCoordinator(pool, {
      env: { CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.test" },
    });

    await expect(coordinator.status()).resolves.toMatchObject({
      configuredEpoch: null,
      phase: "unconfigured",
      canActivate: false,
    });
    await expect(coordinator.prepare()).rejects.toBeInstanceOf(
      ProductionDatabaseAdmissionEpochError,
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("prepares the configured epoch idempotently against the advertised worker", async () => {
    const inserted = { ...preparedRow };
    const { pool, query } = sequencedPool([[], [{ floor: "96" }], [inserted], []]);
    const controlToken = "control-token-with-at-least-thirty-two-characters";
    let fetchCount = 0;
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      fetchCount += 1;
      return fetchCount === 1
        ? new Response("", {
            status: 401,
            headers: { date: new Date("2026-09-06T15:01:00.000Z").toUTCString() },
          })
        : workerResponse("2026-09-06T15:01:00.000Z");
    });
    const coordinator = createProductionDatabaseAdmissionEpochCoordinator(pool, {
      env: {
        CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.test",
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: controlToken,
        NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH: epoch,
      },
      fetch: fetcher,
      now: () => new Date("2026-09-06T15:01:00.000Z"),
      uuid: () => "d61adfa3-bad8-46fe-bbbb-f40c596adbe5",
    });

    await expect(coordinator.prepare()).resolves.toMatchObject({
      configuredEpoch: epoch,
      phase: "prepared",
      workerDeploymentVersion: workerVersion,
      projectIdFloor: 96,
      canActivate: false,
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO public.production_database_admission_epochs"),
      ),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const signedHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    await expect(
      verifyControlRequestSignature(
        controlToken,
        {
          method: "GET",
          pathAndQuery: "/_nabuflow/control/v1/version",
          timestamp: signedHeaders.get("x-nabuflow-timestamp")!,
          nonce: signedHeaders.get("x-nabuflow-nonce")!,
          bodySha256: signedHeaders.get("x-nabuflow-body-sha256")!,
          idempotencyKey: "",
          signature: signedHeaders.get("x-nabuflow-signature")!,
          body: "",
        },
        { consumeOnce: async () => true },
        { nowMs: Date.parse("2026-09-06T15:01:00.000Z"), maxClockSkewMs: 60_000 },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("activates only after the drain while holding the project table lock", async () => {
    const activeRow = {
      ...preparedRow,
      state: "active" as const,
      evidence_sha256: "b".repeat(64),
      activated_at: new Date("2026-09-06T15:07:00.000Z"),
      project_id_floor: 643,
    };
    const { pool, query } = sequencedPool([
      [preparedRow],
      [{ ready: true }],
      [{ floor: "643" }],
      [],
      [activeRow],
    ]);
    const coordinator = createProductionDatabaseAdmissionEpochCoordinator(pool, {
      env: {
        CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.test",
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "control-token-with-at-least-thirty-two-characters",
        NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH: epoch,
      },
      fetch: vi.fn(async () => workerResponse("2026-09-06T15:07:00.000Z")),
      now: () => new Date("2026-09-06T15:07:00.000Z"),
    });

    await expect(coordinator.activate()).resolves.toMatchObject({
      phase: "active",
      activeEpoch: epoch,
      projectIdFloor: 643,
      canActivate: false,
    });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("LOCK TABLE public.projects IN SHARE ROW EXCLUSIVE MODE");
    expect(statements.some((sql) => sql.includes("nextval(pg_get_serial_sequence"))).toBe(true);
    expect(statements.some((sql) => sql.includes("state = 'closed'"))).toBe(true);
  });

  it("does not reserve a sequence value when the database drain is incomplete", async () => {
    const { pool, query } = sequencedPool([[preparedRow], [{ ready: false }]]);
    const coordinator = createProductionDatabaseAdmissionEpochCoordinator(pool, {
      env: {
        CLOUDFLARE_RUNTIME_CONTROL_URL: "https://runtime.example.test",
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: "control-token-with-at-least-thirty-two-characters",
        NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH: epoch,
      },
      fetch: vi.fn(async () => workerResponse("2026-09-06T15:01:00.000Z")),
      now: () => new Date("2026-09-06T15:01:00.000Z"),
    });

    await expect(coordinator.activate()).rejects.toMatchObject({
      code: "production_database_admission_epoch_drain_incomplete",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("nextval("))).toBe(false);
  });
});
