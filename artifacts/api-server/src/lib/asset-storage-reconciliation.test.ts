import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQuery = vi.hoisted(() => vi.fn());
const clientQuery = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn(async () => ({ query: clientQuery, release })));

vi.mock("@workspace/db", () => ({
  pool: { query: poolQuery, connect },
}));
vi.mock("./asset-r2", () => ({ headAssetObject: vi.fn() }));

import {
  ASSET_STORAGE_RECONCILIATION_LIMIT,
  reconcileUnmeasuredR2AssetObjects,
  runDurableAssetStorageReconciliation,
} from "./asset-storage-reconciliation";

function candidate(id: number, role = "primary") {
  return {
    object_id: id,
    asset_id: 100 + id,
    storage_key: `accounts/owner/assets/${id}.bin`,
    storage_backend: "r2",
    role,
  };
}

describe("unmeasured asset storage reconciliation", () => {
  beforeEach(() => {
    poolQuery.mockReset();
    clientQuery.mockReset();
    connect.mockClear();
    release.mockReset();
  });

  it("clamps the candidate batch and therefore provider HEAD work to the bounded limit", async () => {
    const rows = Array.from({ length: ASSET_STORAGE_RECONCILIATION_LIMIT }, (_, index) =>
      candidate(index + 1),
    );
    poolQuery
      .mockResolvedValueOnce({ rowCount: rows.length, rows })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "50" }] });
    const headObject = vi.fn(async () => null);

    const receipt = await reconcileUnmeasuredR2AssetObjects({
      limit: ASSET_STORAGE_RECONCILIATION_LIMIT * 20,
      headObject,
    });

    expect(poolQuery.mock.calls[0]?.[1]).toEqual([ASSET_STORAGE_RECONCILIATION_LIMIT]);
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain("LIMIT $1");
    expect(headObject).toHaveBeenCalledTimes(ASSET_STORAGE_RECONCILIATION_LIMIT);
    expect(receipt.inspected).toBe(ASSET_STORAGE_RECONCILIATION_LIMIT);
    expect(receipt).toMatchObject({ remainingUnmeasured: 50, admissionUnlocked: false });
    expect(connect).not.toHaveBeenCalled();
  });

  it("moves quota by the exact asset-total delta, not by the observed object size", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(7)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "90" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // physical-object receipt
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "130" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // asset total
      .mockResolvedValueOnce({ rowCount: 1 }) // quota receipt
      .mockResolvedValueOnce({}); // COMMIT

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => ({ sizeBytes: 100 })) }),
    ).resolves.toMatchObject({
      measured: 1,
      measuredBytes: 100,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
    });

    const quotaCall = clientQuery.mock.calls.find(([statement]) =>
      String(statement).includes("UPDATE account_asset_quota"),
    );
    expect(quotaCall?.[1]).toEqual(["owner", 40]);
    expect(String(quotaCall?.[0])).toContain("used_bytes+$2");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("records an observed zero-byte object as measured so it cannot deadlock admission", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(8)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "0" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => ({ sizeBytes: 0 })) }),
    ).resolves.toMatchObject({
      measured: 1,
      measuredBytes: 0,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
    });

    const measuredCall = clientQuery.mock.calls.find(([statement]) =>
      String(statement).includes("UPDATE asset_storage_objects SET size_bytes"),
    );
    expect(String(measuredCall?.[0])).toContain("size_measured_at=NOW()");
    expect(String(measuredCall?.[0])).toContain("size_measured_at IS NULL");
  });

  it("keeps a missing thumbnail ready and unmeasured without any metadata writes", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(9, "thumbnail")] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "1" }] });

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => null) }),
    ).resolves.toEqual({
      inspected: 1,
      measured: 0,
      measuredBytes: 0,
      absentThumbnails: 1,
      remainingUnmeasured: 1,
      admissionUnlocked: false,
      terminals: [{ assetId: 109, objectId: 9, role: "thumbnail", outcome: "thumbnail-missing" }],
    });

    expect(connect).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(2);
    for (const [statement] of poolQuery.mock.calls) {
      expect(String(statement).trim()).toMatch(/^SELECT\b/iu);
      expect(String(statement)).toContain("object.state='ready'");
      expect(String(statement)).toContain("object.size_measured_at IS NULL");
    }
  });

  it("preserves measured progress and its exact quota delta alongside an unresolved thumbnail", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [candidate(7), candidate(9, "thumbnail")] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "1" }] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "90" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "130" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const headObject = vi.fn(async (key: string) =>
      key === candidate(7).storage_key ? { sizeBytes: 100 } : null,
    );

    await expect(reconcileUnmeasuredR2AssetObjects({ headObject })).resolves.toEqual({
      inspected: 2,
      measured: 1,
      measuredBytes: 100,
      absentThumbnails: 1,
      remainingUnmeasured: 1,
      admissionUnlocked: false,
      terminals: [{ assetId: 109, objectId: 9, role: "thumbnail", outcome: "thumbnail-missing" }],
    });

    expect(headObject).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();
    const objectWrites = clientQuery.mock.calls.filter(([statement]) =>
      String(statement).includes("UPDATE asset_storage_objects"),
    );
    expect(objectWrites).toHaveLength(1);
    expect(objectWrites[0]?.[1]).toEqual([7, 107, 100]);
    const quotaCall = clientQuery.mock.calls.find(([statement]) =>
      String(statement).includes("UPDATE account_asset_quota"),
    );
    expect(quotaCall?.[1]).toEqual(["owner", 40]);
    const statements = clientQuery.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(statements).not.toMatch(/generated_images|deleted_at|SET\s+state\s*=/iu);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("reports a missing primary as terminal without mutating metadata", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(11)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "1" }] });

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => null) }),
    ).resolves.toEqual({
      inspected: 1,
      measured: 0,
      measuredBytes: 0,
      absentThumbnails: 0,
      remainingUnmeasured: 1,
      admissionUnlocked: false,
      terminals: [{ assetId: 111, objectId: 11, role: "primary", outcome: "primary-missing" }],
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("measures legacy-object metadata through the same bounded candidate contract", async () => {
    poolQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...candidate(12), storage_backend: "legacy-object" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "0" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "25" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const headObject = vi.fn(async () => ({ sizeBytes: 25 }));

    await expect(reconcileUnmeasuredR2AssetObjects({ headObject })).resolves.toMatchObject({
      measured: 1,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
    });
    expect(headObject).toHaveBeenCalledWith("accounts/owner/assets/12.bin", "legacy-object");
  });

  it("durably replays a missing thumbnail without touching Aura or NabuFlow aliases or storage lifecycle", async () => {
    const claimToken = "2026-09-05 06:00:00.123456+00";
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(9, "thumbnail")] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "1" }] });
    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ request_id: "missing-thumbnail", claim_token: claimToken }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const headObject = vi.fn(async () => null);

    const receipt = await runDurableAssetStorageReconciliation({
      requestId: "missing-thumbnail",
      limit: 1,
      headObject,
    });

    expect(receipt).toEqual({
      inspected: 1,
      measured: 0,
      measuredBytes: 0,
      absentThumbnails: 1,
      remainingUnmeasured: 1,
      admissionUnlocked: false,
      terminals: [{ assetId: 109, objectId: 9, role: "thumbnail", outcome: "thumbnail-missing" }],
    });
    const completion = clientQuery.mock.calls.find(([statement]) =>
      String(statement).includes("state='completed', receipt=$2::jsonb"),
    );
    expect(completion?.[1]?.[0]).toBe("missing-thumbnail");
    expect(completion?.[1]?.[2]).toBe(claimToken);
    expect(String(completion?.[0])).toContain("updated_at=$3::timestamptz");
    const persistedReceipt = JSON.parse(completion?.[1]?.[1] as string);
    expect(persistedReceipt).toEqual(receipt);

    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: false }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ state: "completed", receipt: persistedReceipt, terminal: null }],
      });
    await expect(
      runDurableAssetStorageReconciliation({
        requestId: "missing-thumbnail",
        limit: 1,
        headObject,
      }),
    ).resolves.toEqual(receipt);

    expect(headObject).toHaveBeenCalledOnce();
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    // No domain-table writes means neither platform's aliases, nor any shared
    // asset's project, scope, owner, lifecycle, storage location or quota can change.
    for (const [statement] of clientQuery.mock.calls) {
      expect(String(statement)).not.toMatch(
        /\b(?:generated_images|asset_storage_objects|assets|asset_usage|account_asset_quota)\b/iu,
      );
    }
    for (const [statement] of poolQuery.mock.calls) {
      expect(String(statement).trim()).toMatch(/^SELECT\b/iu);
    }
    expect(
      clientQuery.mock.calls.filter(([statement]) =>
        String(statement).includes("pg_advisory_unlock"),
      ),
    ).toHaveLength(1);
  });

  it("rejects lock contention without creating or failing a durable run", async () => {
    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      runDurableAssetStorageReconciliation({ requestId: "request-1", limit: 1 }),
    ).rejects.toMatchObject({
      code: "asset_storage_reconciliation_failed",
      terminal: { retryable: true, errorClass: "database" },
    });

    expect(String(clientQuery.mock.calls[0]?.[0])).toContain("pg_try_advisory_lock");
    expect(clientQuery).toHaveBeenCalledTimes(2);
    for (const [statement] of clientQuery.mock.calls) {
      expect(String(statement).trim()).toMatch(/^SELECT\b/iu);
    }
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not let a stale same-ID retry poison an active original run", async () => {
    const requestId = "concurrent-same-id";
    const originalToken = "2026-09-05 06:00:00.123456+00";
    const retryToken = "2026-09-05 06:16:00.123456+00";
    const store: {
      run: null | { state: string; token: string; receipt: unknown; terminal: unknown };
      lockOwner: number | null;
      elapsedMinutes: number;
    } = { run: null, lockOwner: null, elapsedMinutes: 0 };
    const makeClient = (session: number) => {
      const query = vi.fn();
      query.mockImplementation(async (statement: string, values: unknown[] = []) => {
        if (statement.includes("pg_try_advisory_lock")) {
          const acquired = store.lockOwner === null;
          if (acquired) store.lockOwner = session;
          return { rowCount: 1, rows: [{ acquired }] };
        }
        if (statement.includes("pg_advisory_unlock")) {
          if (store.lockOwner === session) store.lockOwner = null;
          return { rowCount: 1, rows: [] };
        }
        if (statement.includes("SELECT state, receipt, terminal")) {
          return { rowCount: store.run ? 1 : 0, rows: store.run ? [{ ...store.run }] : [] };
        }
        if (statement.includes("INSERT INTO asset_storage_reconciliation_runs")) {
          if (store.run) return { rowCount: 0, rows: [] };
          store.run = { state: "running", token: originalToken, receipt: null, terminal: null };
          return { rowCount: 1, rows: [{ request_id: requestId, claim_token: originalToken }] };
        }
        if (statement.includes("SET updated_at=NOW()")) {
          if (store.run?.state !== "running" || store.elapsedMinutes <= Number(values[1])) {
            return { rowCount: 0, rows: [] };
          }
          store.run.token = retryToken;
          return { rowCount: 1, rows: [{ request_id: requestId, claim_token: retryToken }] };
        }
        if (
          statement.includes("SET state='completed'") ||
          statement.includes("SET state='failed'")
        ) {
          if (
            store.run?.state !== "running" ||
            (values[2] !== undefined && values[2] !== store.run.token)
          ) {
            return { rowCount: 0, rows: [] };
          }
          if (statement.includes("SET state='completed'")) {
            store.run.state = "completed";
            store.run.receipt = JSON.parse(values[1] as string);
          } else {
            store.run.state = "failed";
            store.run.terminal = JSON.parse(values[1] as string);
          }
          return { rowCount: 1, rows: [{ request_id: requestId }] };
        }
        throw new Error(`Unexpected coordinator statement: ${statement}`);
      });
      return { query, release: vi.fn() };
    };
    const originalClient = makeClient(1);
    const retryClient = makeClient(2);
    const replayClient = makeClient(3);
    connect
      .mockResolvedValueOnce(originalClient)
      .mockResolvedValueOnce(retryClient)
      .mockResolvedValueOnce(replayClient);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(9, "thumbnail")] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "1" }] });
    let enteredHead!: () => void;
    let releaseHead!: (value: null) => void;
    const headEntered = new Promise<void>((resolve) => {
      enteredHead = resolve;
    });
    const headResult = new Promise<null>((resolve) => {
      releaseHead = resolve;
    });
    const headObject = vi.fn(async () => {
      enteredHead();
      return headResult;
    });

    const original = runDurableAssetStorageReconciliation({ requestId, limit: 1, headObject });
    await headEntered;
    // Advance the simulated DB lease beyond 15 minutes without releasing the
    // original session's global lock or relying on wall-clock sleeps.
    store.elapsedMinutes = 16;
    try {
      await expect(
        runDurableAssetStorageReconciliation({ requestId, limit: 1, headObject }),
      ).rejects.toMatchObject({
        code: "asset_storage_reconciliation_failed",
        terminal: { retryable: true, errorClass: "database" },
      });
      expect(store.run).toMatchObject({ state: "running", token: originalToken, terminal: null });
      expect(store.lockOwner).toBe(1);
      for (const [statement] of retryClient.query.mock.calls) {
        expect(String(statement).trim()).toMatch(/^SELECT\b/iu);
      }
    } finally {
      releaseHead(null);
    }
    const receipt = await original;
    expect(store.run).toMatchObject({ state: "completed", receipt, terminal: null });
    expect(receipt).toMatchObject({
      measured: 0,
      remainingUnmeasured: 1,
      admissionUnlocked: false,
    });
    await expect(
      runDurableAssetStorageReconciliation({ requestId, limit: 1, headObject }),
    ).resolves.toEqual(receipt);
    expect(headObject).toHaveBeenCalledOnce();
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(store.lockOwner).toBeNull();
    for (const session of [originalClient, retryClient, replayClient]) {
      expect(session.release).toHaveBeenCalledOnce();
    }
  });

  it("rejects a zero-row completion and fences the failure attempt to the same claim", async () => {
    const claimToken = "2026-09-05 06:00:00.123456+00";
    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ claim_token: claimToken }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // completion lost its claim
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // cannot overwrite its successor
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });

    await expect(
      runDurableAssetStorageReconciliation({ requestId: "lost-completion", limit: 1 }),
    ).rejects.toMatchObject({
      code: "asset_storage_reconciliation_failed",
      terminal: { retryable: true, errorClass: "database" },
    });
    const terminalWrites = clientQuery.mock.calls.filter(([statement]) =>
      /SET state='(?:completed|failed)'/u.test(String(statement)),
    );
    expect(terminalWrites).toHaveLength(2);
    for (const [statement, values] of terminalWrites) {
      expect(String(statement)).toContain("state='running' AND updated_at=$3::timestamptz");
      expect(values[0]).toBe("lost-completion");
      expect(values[2]).toBe(claimToken);
    }
    expect(String(clientQuery.mock.calls.at(-1)?.[0])).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reclaims an orphan only when its lease is stale: %s", async (stale) => {
    const claimToken = "2026-09-05 06:16:00.654321+00";
    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: true }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ state: "running", receipt: null, terminal: null }],
      })
      .mockResolvedValueOnce({
        rowCount: stale ? 1 : 0,
        rows: stale ? [{ claim_token: claimToken }] : [],
      });
    if (stale) {
      clientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
      poolQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    }
    clientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const attempt = runDurableAssetStorageReconciliation({ requestId: "orphan", limit: 1 });
    if (stale) {
      await expect(attempt).resolves.toMatchObject({ measured: 0, admissionUnlocked: true });
      expect(clientQuery.mock.calls[3]?.[1]?.[2]).toBe(claimToken);
    } else {
      await expect(attempt).rejects.toMatchObject({ code: "asset_storage_reconciliation_failed" });
      expect(poolQuery).not.toHaveBeenCalled();
    }
    expect(String(clientQuery.mock.calls[0]?.[0])).toContain("pg_try_advisory_lock");
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("updated_at < NOW()");
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("updated_at::text AS claim_token");
    expect(clientQuery.mock.calls[2]?.[1]).toEqual(["orphan", 15]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("replays a stored failure without mutation even while the global lock is busy", async () => {
    const terminal = {
      code: "asset_storage_reconciliation_failed",
      retryable: true,
      errorClass: "provider",
    };
    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ state: "failed", receipt: null, terminal }] });

    await expect(
      runDurableAssetStorageReconciliation({ requestId: "failed-replay", limit: 1 }),
    ).rejects.toMatchObject({ terminal });
    expect(clientQuery).toHaveBeenCalledTimes(2);
    for (const [statement] of clientQuery.mock.calls) {
      expect(String(statement).trim()).toMatch(/^SELECT\b/iu);
    }
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
