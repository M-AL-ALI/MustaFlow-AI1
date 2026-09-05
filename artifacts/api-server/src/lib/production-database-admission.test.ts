import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  productionDatabaseAllocationIdentity,
  sha256Hex,
} from "@workspace/tenant-runtime-contracts";
import { createProductionDatabaseAdmissionService } from "./production-database-admission";

vi.mock("./project-retirement-contract", () => ({
  hasCurrentProjectRetirementCompletionEvidence: (progress: unknown) =>
    !!progress &&
    typeof progress === "object" &&
    "complete" in progress &&
    progress.complete === true,
  hasProjectRestoreReplayReceipt: ({ progress }: { progress: { restored?: boolean } }) =>
    progress.restored === true,
}));

const epoch = "11111111-1111-4111-8111-111111111111";
const birthToken = "22222222-2222-4222-8222-222222222222";
const generatedId = "33333333-3333-4333-8333-333333333333";

async function fixture() {
  const allocationIdentity = await productionDatabaseAllocationIdentity({
    format: "nabuflow.production-database-allocation/v1",
    deploymentNamespace: "production",
    projectId: 123,
  });
  type Row = {
    project_id: number;
    registration_epoch: string;
    birth_token: string;
    birth_registered: boolean;
    allocation_identity: string | null;
    state: string;
    authorization_id: string | null;
    seal_id: string | null;
  };
  let row: Row | undefined = {
    project_id: 123,
    registration_epoch: epoch,
    birth_token: birthToken,
    birth_registered: true,
    allocation_identity: null,
    state: "fresh",
    authorization_id: null,
    seal_id: null,
  };
  const state = {
    project: { id: 123, deleted_at: null as Date | null } as
      | { id: number; deleted_at: Date | null }
      | undefined,
    active: true,
    purge: true,
    retirement: true,
    completed: true,
    restored: false,
    retirementId: "retirement-123",
    failCommit: false,
    abortOnCommit: undefined as AbortController | undefined,
    beforeWrite: undefined as (() => void) | undefined,
  };
  let saved: Row | undefined;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[] = [];
    if (sql === "BEGIN") saved = row ? { ...row } : undefined;
    else if (sql === "ROLLBACK") row = saved ? { ...saved } : undefined;
    else if (sql === "COMMIT") {
      if (state.failCommit) throw new Error("commit failed");
      state.abortOnCommit?.abort();
    } else if (sql.startsWith("SELECT id, deleted_at")) rows = state.project ? [state.project] : [];
    else if (sql.startsWith("SELECT epoch")) rows = state.active ? [{ epoch }] : [];
    else if (sql.startsWith("SELECT *")) rows = row ? [{ ...row }] : [];
    else if (sql.startsWith("SELECT id, state"))
      rows = state.retirement
        ? [
            {
              id: state.retirementId,
              state: "completed",
              completed_at: new Date(),
              progress: { complete: state.completed, restored: state.restored },
            },
          ]
        : [];
    else if (sql.startsWith("SELECT id FROM public.project_purge")) {
      expect(values).toEqual([123, await sha256Hex(state.retirementId)]);
      expect(sql).toContain("lease_expires_at > clock_timestamp()");
      rows = state.purge ? [{ id: "purge-123" }] : [];
    } else if (sql.startsWith("UPDATE public.production_database_admission_receipts")) {
      state.beforeWrite?.();
      if (!row) throw new Error("missing fixture row");
      row = { ...row, allocation_identity: String(values[1]) };
      if (sql.includes("SET state = 'authorized'")) {
        row.state = "authorized";
        row.authorization_id = String(values[2]);
      } else {
        row.state = "sealed";
        row.seal_id = String(values[2]);
      }
      rows = [{ ...row }];
    } else if (sql.startsWith("INSERT INTO public.production_database_admission_receipts")) {
      state.beforeWrite?.();
      row = {
        project_id: Number(values[0]),
        registration_epoch: String(values[1]),
        birth_token: String(values[2]),
        birth_registered: false,
        allocation_identity: String(values[3]),
        state: sql.includes("'authorized'") ? "authorized" : "sealed",
        authorization_id: sql.includes("'authorized'") ? String(values[4]) : null,
        seal_id: sql.includes("'sealed'") ? String(values[4]) : null,
      };
      rows = [{ ...row }];
    }
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient) };
  const service = createProductionDatabaseAdmissionService(
    pool as unknown as Pick<Pool, "connect">,
    {
      epoch: () => epoch,
      uuid: () => generatedId,
    },
  );
  return {
    input: { projectId: 123, allocationIdentity },
    state,
    query,
    release,
    pool,
    service,
    getRow: () => row,
    setRow: (next: Row | undefined) => {
      row = next;
    },
  };
}

describe("durable production database admission", () => {
  it("commits before returning birth-bound authorization and reuses the authorization on retry", async () => {
    const f = await fixture();
    const first = await f.service.authorize(f.input);
    expect(first).toMatchObject({
      assertion: "authorized",
      birthRegistered: true,
      birthToken,
      receiptId: generatedId,
    });
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(await f.service.authorize(f.input)).toEqual(first);
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE "))).toHaveLength(1);
  });

  it("records a legacy authorization without inventing birth evidence", async () => {
    const f = await fixture();
    f.setRow(undefined);
    expect(await f.service.authorize(f.input)).toMatchObject({
      assertion: "authorized",
      birthRegistered: false,
    });
    expect(f.getRow()?.birth_registered).toBe(false);
  });

  it("seals fresh births only for completed retirement and a live matching purge", async () => {
    const f = await fixture();
    f.state.project!.deleted_at = new Date();
    const first = await f.service.seal(f.input);
    expect(first).toMatchObject({ assertion: "sealed", birthRegistered: true, birthToken });
    expect(await f.service.seal(f.input)).toEqual(first);
    f.state.project = undefined;
    expect(await f.service.seal(f.input)).toEqual(first);
  });

  it("seals legacy records without authorizing negative absence proof", async () => {
    const f = await fixture();
    f.setRow(undefined);
    f.state.project!.deleted_at = new Date();
    expect(await f.service.seal(f.input)).toMatchObject({
      assertion: "sealed",
      birthRegistered: false,
    });
  });

  it.each(["retirement", "completed", "purge"] as const)(
    "rejects missing %s authority without changing fresh state",
    async (key) => {
      const f = await fixture();
      f.state.project!.deleted_at = new Date();
      f.state[key] = false;
      await expect(f.service.seal(f.input)).rejects.toHaveProperty("code");
      expect(f.getRow()?.state).toBe("fresh");
      expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    },
  );

  it("rejects restored retirement receipts", async () => {
    const f = await fixture();
    f.state.project!.deleted_at = new Date();
    f.state.restored = true;
    await expect(f.service.seal(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_retirement_incomplete",
    );
  });

  it("cannot authorize after sealing even if an application bug makes the project active again", async () => {
    const f = await fixture();
    f.state.project!.deleted_at = new Date();
    await f.service.seal(f.input);
    f.state.project!.deleted_at = null;
    await expect(f.service.authorize(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_sealed",
    );
  });

  it("rejects Trash authorization, active-project sealing, and missing-project fabrication", async () => {
    const f = await fixture();
    await expect(f.service.seal(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_project_not_in_trash",
    );
    f.state.project!.deleted_at = new Date();
    await expect(f.service.authorize(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_project_inactive",
    );
    f.state.project = undefined;
    await expect(f.service.seal(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_project_missing",
    );
  });

  it("rejects cross-project allocation and stale epochs before issuing authority", async () => {
    const f = await fixture();
    await expect(f.service.authorize({ ...f.input, projectId: 51 })).rejects.toHaveProperty(
      "code",
      "production_database_admission_identity_mismatch",
    );
    expect(f.pool.connect).not.toHaveBeenCalled();
    f.state.active = false;
    await expect(f.service.authorize(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_epoch_inactive",
    );
  });

  it("rejects a ledger whose binding differs from the canonical project", async () => {
    const f = await fixture();
    f.setRow({ ...f.getRow()!, allocation_identity: "0".repeat(64) });
    await expect(f.service.authorize(f.input)).rejects.toHaveProperty(
      "code",
      "production_database_admission_identity_mismatch",
    );
  });

  it("rolls back failed commits and releases the connection", async () => {
    const f = await fixture();
    f.state.failCommit = true;
    await expect(f.service.authorize(f.input)).rejects.toThrow("commit failed");
    expect(f.getRow()?.state).toBe("fresh");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rolls back precommit cancellation but never rolls committed authority back after caller cancellation", async () => {
    const before = await fixture();
    const pre = new AbortController();
    before.state.beforeWrite = () => pre.abort();
    await expect(
      before.service.authorize({ ...before.input, signal: pre.signal }),
    ).rejects.toThrow();
    expect(before.getRow()?.state).toBe("fresh");
    const after = await fixture();
    const post = new AbortController();
    after.state.abortOnCommit = post;
    await expect(
      after.service.authorize({ ...after.input, signal: post.signal }),
    ).rejects.toThrow();
    expect(after.getRow()?.state).toBe("authorized");
    expect(after.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(after.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
  });

  it("does not connect for an already-aborted request", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.service.authorize({ ...f.input, signal: controller.signal })).rejects.toThrow();
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
});
