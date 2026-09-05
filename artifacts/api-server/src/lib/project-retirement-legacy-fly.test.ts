import { describe, expect, it, vi } from "vitest";
import {
  reconcileLegacyFlyRuntime,
  type LegacyFlyRetirementRequest,
} from "./project-retirement-legacy-fly";

const MACHINE_ID = "9080e521b67587";
const PROJECT_ID = 77;

function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Awaited<ReturnType<LegacyFlyRetirementRequest>> {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function ownedMachine(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MACHINE_ID,
    name: `project-${PROJECT_ID}`,
    state: "stopped",
    config: {
      env: { PROJECT_ID: String(PROJECT_ID) },
      mounts: [],
    },
    ...override,
  };
}

const LEASE_NONCE = "private-test-lease-nonce";

function authorizedInput() {
  return {
    machineId: MACHINE_ID,
    projectId: PROJECT_ID,
    assertAuthority: vi.fn(async () => undefined),
  };
}

function leaseResponse(data: Record<string, unknown> = {}): Response {
  return response(201, {
    status: "success",
    data: {
      nonce: LEASE_NONCE,
      expires_at: Math.floor(Date.now() / 1_000) + 300,
      owner: "test-owner",
      description: "Legacy runtime retirement",
      version: "test-version",
      ...data,
    },
  });
}

function deletionRequest(
  options: {
    lease?: Response;
    currentMachine?: Response;
    currentCatalog?: Response;
    deletion?: Response;
    verification?: Response;
    finalCatalog?: Response;
  } = {},
) {
  return vi
    .fn<LegacyFlyRetirementRequest>()
    .mockResolvedValueOnce(response(200, ownedMachine()))
    .mockResolvedValueOnce(response(200, []))
    .mockResolvedValueOnce(options.lease ?? leaseResponse())
    .mockResolvedValueOnce(options.currentMachine ?? response(200, ownedMachine()))
    .mockResolvedValueOnce(options.currentCatalog ?? response(200, []))
    .mockResolvedValueOnce(options.deletion ?? response(204))
    .mockResolvedValueOnce(options.verification ?? response(404))
    .mockResolvedValueOnce(options.finalCatalog ?? response(200, []))
    .mockResolvedValue(response(204));
}

function machineDeletes(request: ReturnType<typeof vi.fn<LegacyFlyRetirementRequest>>) {
  return request.mock.calls.filter(([call]) => call.method === "DELETE" && !call.resource);
}

describe("destroyed Fly tombstone absence proof", () => {
  const tombstone = (extra: Record<string, unknown> = {}) =>
    ownedMachine({ state: "destroyed", ...extra });
  const otherMachine = {
    id: "other-machine",
    name: "project-78",
    state: "started",
    config: { env: { PROJECT_ID: "78" } },
  };
  type Observation = () => Response;

  function tombstoneRequest(
    options: {
      afterDelete?: boolean;
      running?: boolean;
      tombstones?: Observation[];
      activeCatalogs?: Observation[];
      volumeCatalogs?: Observation[];
      onRelease?: () => void;
    } = {},
  ) {
    let deleted = false;
    let liveReads = 0;
    let tombstoneReads = 0;
    let activeReads = 0;
    let volumeReads = 0;
    return vi.fn<LegacyFlyRetirementRequest>().mockImplementation(async (call) => {
      if (call.resource === "lease") {
        if (call.method === "POST") return leaseResponse();
        options.onRelease?.();
        return response(404);
      }
      if (call.resource === "machines")
        return options.activeCatalogs?.[activeReads++]?.() ?? response(200, []);
      if (call.resource === "volumes")
        return options.volumeCatalogs?.[volumeReads++]?.() ?? response(200, []);
      if (call.resource === "stop" || call.resource === "wait") return response(200, { ok: true });
      if (call.method === "DELETE") {
        deleted = true;
        return response(204);
      }
      if (options.afterDelete && !deleted) {
        return response(
          200,
          options.running
            ? ownedMachine({
                state: liveReads++ < 2 ? "started" : "stopped",
                instance_id: "A".repeat(26),
                config: {
                  env: { PROJECT_ID: String(PROJECT_ID) },
                  mounts: [],
                  auto_destroy: false,
                },
              })
            : ownedMachine(),
        );
      }
      return options.tombstones?.[tombstoneReads++]?.() ?? response(200, tombstone());
    });
  }

  it("proves an already destroyed machine using two owned GETs and two complete catalogs of each kind", async () => {
    const input = authorizedInput();
    const request = tombstoneRequest();
    expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
      state: "verified_absent",
      proof: "initial_destroyed_tombstone_active_catalog_absent",
    });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      { machineId: MACHINE_ID, method: "GET" },
      { resource: "machines", method: "GET" },
      { resource: "volumes", method: "GET" },
      { machineId: MACHINE_ID, method: "GET" },
      { resource: "machines", method: "GET" },
      { resource: "volumes", method: "GET" },
    ]);
    expect(input.assertAuthority).toHaveBeenCalledTimes(3);
  });

  it("accepts the Project 27 tombstone shape without auto_destroy and a complete 40-row active catalog", async () => {
    const machineId = "18551d6b7229e8";
    const input = { ...authorizedInput(), machineId, projectId: 27 };
    const machine = {
      id: machineId,
      name: "project-27",
      state: "destroyed",
      config: { env: { PROJECT_ID: "27" } },
    };
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: "other-" + index,
      name: "project-" + (100 + index),
      state: "started",
      config: { env: { PROJECT_ID: String(100 + index) } },
    }));
    const request = vi.fn<LegacyFlyRetirementRequest>().mockImplementation(async (call) => {
      if (call.resource === "machines") return response(200, rows, { "x-total-count": "40" });
      if (call.resource === "volumes") return response(200, []);
      if (call.method !== "GET" || call.resource) throw new Error("Unexpected mutation");
      return response(200, machine);
    });
    expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
      state: "verified_absent",
      proof: "initial_destroyed_tombstone_active_catalog_absent",
    });
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
  });

  it.each([false, true])(
    "proves a post-delete tombstone after ordinary running=%s deletion",
    async (running) => {
      const input = authorizedInput();
      const request = tombstoneRequest({ afterDelete: true, running });
      expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
        state: "verified_absent",
        proof: "delete_then_destroyed_tombstone_active_catalog_absent",
      });
      expect(machineDeletes(request).map(([call]) => call)).toEqual([
        { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
      ]);
      expect(request.mock.calls.filter(([call]) => call.resource === "stop")).toHaveLength(
        running ? 1 : 0,
      );
      expect(request.mock.calls.filter(([call]) => call.resource === "machines")).toHaveLength(2);
      expect(request.mock.calls.at(-1)?.[0]).toEqual({
        resource: "lease",
        machineId: MACHINE_ID,
        method: "DELETE",
        leaseNonce: LEASE_NONCE,
      });
      expect(input.assertAuthority).toHaveBeenCalledTimes(running ? 9 : 6);
    },
  );

  const unsafeCatalogs: Array<[string, Observation]> = [
    ["unavailable", () => response(503)],
    ["partial", () => response(206, [])],
    ["404 catalog", () => response(404)],
    ["missing body", () => response(200)],
    ["malformed JSON", () => new Response("{provider-secret", { status: 200 })],
    ["envelope", () => response(200, { machines: [], next_cursor: null })],
    ["scalar row", () => response(200, [null])],
    ["invalid id", () => response(200, [{ ...otherMachine, id: "bad/id" }])],
    ["missing name", () => response(200, [{ ...otherMachine, name: null }])],
    ["missing config", () => response(200, [{ ...otherMachine, config: null }])],
    ["malformed environment", () => response(200, [{ ...otherMachine, config: { env: [] } }])],
    ["deleted catalog row", () => response(200, [{ ...otherMachine, state: "destroyed" }])],
    ["target id", () => response(200, [{ ...otherMachine, id: MACHINE_ID }])],
    [
      "target name on another id",
      () => response(200, [{ ...otherMachine, name: `project-${PROJECT_ID}` }]),
    ],
    [
      "target env on another id",
      () =>
        response(200, [{ ...otherMachine, config: { env: { PROJECT_ID: String(PROJECT_ID) } } }]),
    ],
    [
      "hidden target owner",
      () => response(200, [{ ...otherMachine, metadata: { nabu_project_id: PROJECT_ID } }]),
    ],
    [
      "contradictory owner",
      () => response(200, [{ ...otherMachine, metadata: { project_id: "79" } }]),
    ],
    [
      "malformed owner",
      () => response(200, [{ ...otherMachine, metadata: { project_id: { value: "78" } } }]),
    ],
    ["machine identity alias", () => response(200, [{ ...otherMachine, machine_id: MACHINE_ID }])],
    [
      "project name alias",
      () => response(200, [{ ...otherMachine, project_name: `project-${PROJECT_ID}` }]),
    ],
    [
      "duplicate id",
      () => response(200, [otherMachine, { ...otherMachine, name: "another-name" }]),
    ],
    ["duplicate name", () => response(200, [otherMachine, { ...otherMachine, id: "another-id" }])],
    [
      "target production alias",
      () =>
        response(200, [
          otherMachine,
          {
            id: "target-production",
            name: `prod-${PROJECT_ID}-12345`,
            state: "started",
            config: { env: { PROJECT_ID: String(PROJECT_ID) } },
          },
        ]),
    ],
    [
      "body pagination marker",
      () => response(200, [{ ...otherMachine, metadata: { next_cursor: "next" } }]),
    ],
    [
      "catalog row bound",
      () =>
        response(
          200,
          Array.from({ length: 1_000 }, () => otherMachine),
        ),
    ],
    [
      "transport error",
      () => {
        throw new Error("provider-secret");
      },
    ],
  ];
  for (const header of [
    "link",
    "content-range",
    "x-next-page",
    "x-next-cursor",
    "next-cursor",
    "x-pagination-next-page",
    "x-page",
    "x-per-page",
    "x-page-size",
    "x-has-more",
  ])
    unsafeCatalogs.push([header, () => response(200, [], { [header]: "0" })]);
  for (const header of ["x-total-count", "x-total"]) {
    for (const value of ["1", "-1", "0.0", "unknown"]) {
      unsafeCatalogs.push([header + "=" + value, () => response(200, [], { [header]: value })]);
    }
  }
  for (const value of ["1048577", "unknown"]) {
    unsafeCatalogs.push([
      "content-length=" + value,
      () => response(200, [], { "content-length": value }),
    ]);
  }

  describe.each([false, true])("afterDelete=%s", (afterDelete) => {
    describe.each([0, 1])("catalog observation %s", (index) => {
      it.each(unsafeCatalogs)("refuses %s without further mutations", async (_label, catalog) => {
        const activeCatalogs = [() => response(200, []), () => response(200, [])];
        activeCatalogs[index] = catalog;
        const request = tombstoneRequest({ afterDelete, activeCatalogs });
        const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
        expect(result).toEqual({
          state: "retained",
          reason: "absence_unverified",
          retryable: true,
        });
        expect(machineDeletes(request)).toHaveLength(afterDelete ? 1 : 0);
        expect(JSON.stringify(result)).not.toContain("provider-secret");
      });
    });

    it.each([
      ["id", { id: "wrong-machine" }],
      ["name", { name: "project-51" }],
      ["environment", { config: { env: { PROJECT_ID: "51" } } }],
      ["nested owner", { metadata: { project_id: "51" } }],
      [
        "mounted storage",
        { config: { env: { PROJECT_ID: String(PROJECT_ID) }, mounts: ["vol_data"] } },
      ],
      ["hidden storage", { "config.mounts": [] }],
    ])("retains a tombstone with wrong %s", async (_label, extra) => {
      const request = tombstoneRequest({
        afterDelete,
        tombstones: [() => response(200, tombstone(extra))],
      });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(machineDeletes(request)).toHaveLength(afterDelete ? 1 : 0);
      expect(request.mock.calls.some(([call]) => call.resource === "machines")).toBe(false);
    });

    it.each(["started", "stopped", "migrated", "replaced", "destroying", "DESTROYED", null])(
      "does not accept a repeated tombstone in state %j",
      async (state) => {
        const request = tombstoneRequest({
          afterDelete,
          tombstones: [() => response(200, tombstone()), () => response(200, tombstone({ state }))],
        });
        expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe(
          "retained",
        );
        expect(machineDeletes(request)).toHaveLength(afterDelete ? 1 : 0);
      },
    );

    it.each([404, 503])(
      "does not relabel a repeated GET %s as a tombstone proof",
      async (status) => {
        const request = tombstoneRequest({
          afterDelete,
          tombstones: [() => response(200, tombstone()), () => response(status)],
        });
        expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe(
          "retained",
        );
      },
    );

    it("retains config drift between destroyed observations", async () => {
      const request = tombstoneRequest({
        afterDelete,
        tombstones: [
          () => response(200, tombstone()),
          () =>
            response(
              200,
              tombstone({
                config: { env: { PROJECT_ID: String(PROJECT_ID), EXTRA: "changed" }, mounts: [] },
              }),
            ),
        ],
      });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    });

    it("retains changes to the complete active identity set", async () => {
      const request = tombstoneRequest({
        afterDelete,
        activeCatalogs: [() => response(200, []), () => response(200, [otherMachine])],
      });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    });

    it.each([0, 1])("retains unsafe volumes at tombstone observation %s", async (index) => {
      const volumeCatalogs = Array.from(
        { length: afterDelete ? 4 : 2 },
        () => () => response(200, []),
      );
      volumeCatalogs[(afterDelete ? 2 : 0) + index] = () =>
        response(200, [{ id: "vol_data", attached_machine_id: null }]);
      const request = tombstoneRequest({ afterDelete, volumeCatalogs });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "storage_ownership_ambiguous",
        retryable: false,
      });
      expect(machineDeletes(request)).toHaveLength(afterDelete ? 1 : 0);
    });

    it("requires repeat volume facts, including after an acknowledged deletion", async () => {
      const volumeCatalogs = Array.from(
        { length: afterDelete ? 4 : 2 },
        () => () => response(200, []),
      );
      volumeCatalogs[volumeCatalogs.length - 1] = () =>
        response(200, [{ id: "vol_other", attached_machine_id: "another-machine" }]);
      const request = tombstoneRequest({ afterDelete, volumeCatalogs });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "storage_ownership_ambiguous",
        retryable: false,
      });
    });

    it.each([1, 2, 3])("propagates authority loss at tombstone assertion %s", async (assertion) => {
      const input = authorizedInput();
      input.assertAuthority.mockImplementation(async () => {
        if (input.assertAuthority.mock.calls.length === assertion + (afterDelete ? 2 : 0)) {
          throw new Error("authority_lost");
        }
      });
      const request = tombstoneRequest({ afterDelete });
      await expect(reconcileLegacyFlyRuntime(input, request)).rejects.toThrow("authority_lost");
      expect(machineDeletes(request)).toHaveLength(afterDelete ? 1 : 0);
      if (afterDelete)
        expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
          resource: "lease",
          method: "DELETE",
        });
    });
  });

  it.each(["stopped", "migrated", "replaced", "started"])(
    "does not infer post-delete absence from GET 200 state=%s",
    async (state) => {
      const request = tombstoneRequest({
        afterDelete: true,
        tombstones: [() => response(200, tombstone({ state }))],
      });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "absence_unverified",
        retryable: true,
      });
      expect(machineDeletes(request)).toHaveLength(1);
      expect(request.mock.calls.some(([call]) => call.resource === "machines")).toBe(false);
    },
  );

  it("permits catalog ordering and unrelated telemetry changes with the same identities", async () => {
    const second = {
      ...otherMachine,
      id: "second",
      name: "project-79",
      config: { env: { PROJECT_ID: "79" } },
    };
    const request = tombstoneRequest({
      activeCatalogs: [
        () => response(200, [otherMachine, second], { "x-total": "2" }),
        () =>
          response(200, [
            second,
            { ...otherMachine, state: "stopped", updated_at: "2026-09-05T00:00:00Z" },
          ]),
      ],
    });
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe(
      "verified_absent",
    );
  });

  it.each([false, true])(
    "allows distinct preview and production machines of another owner afterDelete=%s",
    async (afterDelete) => {
      const preview = {
        ...otherMachine,
        name: "project-20",
        config: { env: { PROJECT_ID: "20" } },
      };
      const production = { ...preview, id: "other-production", name: "prod-20-12345" };
      const request = tombstoneRequest({
        afterDelete,
        activeCatalogs: [
          () => response(200, [preview, production]),
          () => response(200, [production, preview]),
        ],
      });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "verified_absent",
        proof: afterDelete
          ? "delete_then_destroyed_tombstone_active_catalog_absent"
          : "initial_destroyed_tombstone_active_catalog_absent",
      });
    },
  );

  it.each(["depth", "nodes", "bytes"])(
    "bounds active catalog %s before accepting absence",
    async (kind) => {
      let metadata: unknown = Array.from({ length: 16_384 }, () => null);
      if (kind === "depth") {
        metadata = null;
        for (let depth = 0; depth < 34; depth++) metadata = { child: metadata };
      }
      const cancel = vi.fn();
      const catalog = () =>
        kind === "bytes"
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("x".repeat(1_048_577)));
                },
                cancel,
              }),
              { status: 200, headers: { "content-length": "1", "content-encoding": "gzip" } },
            )
          : response(200, [{ ...otherMachine, metadata }]);
      const request = tombstoneRequest({ activeCatalogs: [catalog] });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      if (kind === "bytes") expect(cancel).toHaveBeenCalledTimes(1);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each([0, 1])("rejects a mismatched tombstone lease nonce at observation %s", async (index) => {
    const tombstones = [() => response(200, tombstone()), () => response(200, tombstone())];
    tombstones[index] = () => response(200, tombstone({ nonce: "another-lease" }));
    const request = tombstoneRequest({ afterDelete: true, tombstones });
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ resource: "lease", method: "DELETE" });
  });

  it.each(["before release", "during release", "after release"])(
    "does not return a proof if the Fly lease expires %s",
    async (stage) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const input = authorizedInput();
        input.assertAuthority.mockImplementation(async () => {
          const calls = input.assertAuthority.mock.calls.length;
          if (
            (stage === "before release" && calls === 5) ||
            (stage === "after release" && calls === 6)
          ) {
            clock.mockReturnValue(now + 301_000);
          }
        });
        const request = tombstoneRequest({
          afterDelete: true,
          onRelease: () => {
            if (stage === "during release") clock.mockReturnValue(now + 301_000);
          },
        });
        expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
          state: "retained",
          reason: "absence_unverified",
          retryable: true,
        });
        expect(
          request.mock.calls.filter(
            ([call]) => call.resource === "lease" && call.method === "DELETE",
          ),
        ).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("requires terminal durable authority after releasing the deleted machine lease", async () => {
    const input = authorizedInput();
    const request = tombstoneRequest({ afterDelete: true });
    input.assertAuthority.mockImplementation(async () => {
      if (input.assertAuthority.mock.calls.length === 6) {
        expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
          resource: "lease",
          method: "DELETE",
        });
        throw new Error("authority_lost");
      }
    });
    await expect(reconcileLegacyFlyRuntime(input, request)).rejects.toThrow("authority_lost");
  });
});

describe("running historical Fly retirement", () => {
  const instanceId = "A".repeat(26);
  const runningMachine = (override: Record<string, unknown> = {}) =>
    ownedMachine({
      state: "started",
      instance_id: instanceId,
      config: { env: { PROJECT_ID: String(PROJECT_ID) }, mounts: [], auto_destroy: false },
      ...override,
    });
  const stoppedMachine = (override: Record<string, unknown> = {}) =>
    runningMachine({
      state: "stopped",
      nonce: LEASE_NONCE,
      ...override,
    });

  function runningRequest(
    options: {
      initial?: Record<string, unknown>;
      current?: Record<string, unknown>;
      stopped?: Record<string, unknown>;
      lease?: Response;
      stop?: Response | Error;
      wait?: Response | Error;
      stoppedObservation?: Response | Error;
      catalogs?: Response[];
      deletion?: Response;
    } = {},
  ) {
    let machineReads = 0;
    let catalogReads = 0;
    const machines = [
      options.initial ?? runningMachine(),
      options.current ?? runningMachine({ nonce: LEASE_NONCE }),
      options.stopped ?? stoppedMachine(),
    ];
    return vi.fn<LegacyFlyRetirementRequest>().mockImplementation(async (call) => {
      if (call.resource === "lease") {
        return call.method === "POST" ? (options.lease ?? leaseResponse()) : response(204);
      }
      if (call.resource === "volumes")
        return options.catalogs?.[catalogReads++] ?? response(200, []);
      if (call.resource === "stop" || call.resource === "wait") {
        const result = options[call.resource] ?? response(200, { ok: true });
        if (result instanceof Error) throw result;
        return result;
      }
      if (call.method === "DELETE") return options.deletion ?? response(204);
      const index = machineReads++;
      if (index === 2 && options.stoppedObservation) {
        if (options.stoppedObservation instanceof Error) throw options.stoppedObservation;
        return options.stoppedObservation;
      }
      return index < machines.length ? response(200, machines[index]) : response(404);
    });
  }

  function stops(request: ReturnType<typeof runningRequest>) {
    return request.mock.calls.filter(([call]) => call.resource === "stop");
  }

  it("stops, waits for the exact version, reobserves ownership/storage, then deletes under one lease", async () => {
    const input = authorizedInput();
    const request = runningRequest();
    expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
      state: "verified_absent",
      proof: "delete_then_get_404",
    });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      { machineId: MACHINE_ID, method: "GET" },
      { resource: "volumes", method: "GET" },
      {
        resource: "lease",
        machineId: MACHINE_ID,
        method: "POST",
        description: "Legacy runtime retirement",
        ttl: 300,
      },
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
      { resource: "volumes", method: "GET" },
      { resource: "stop", machineId: MACHINE_ID, method: "POST", leaseNonce: LEASE_NONCE },
      {
        resource: "wait",
        machineId: MACHINE_ID,
        method: "GET",
        instanceId,
        leaseNonce: LEASE_NONCE,
      },
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
      { resource: "volumes", method: "GET" },
      { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
      { resource: "volumes", method: "GET" },
      { resource: "lease", machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
    ]);
    expect(input.assertAuthority).toHaveBeenCalledTimes(6);
  });

  it("allows only documented stop telemetry and safe volume usage counters to change", async () => {
    const telemetry = {
      updated_at: "2026-09-03T00:00:00Z",
      events: [{ type: "start", status: "started" }],
      checks: [{ name: "http", status: "passing" }],
    };
    const otherVolume = {
      id: "vol_other",
      attached_machine_id: "other-machine",
      blocks_free: 100,
      blocks_avail: 90,
    };
    const request = runningRequest({
      initial: runningMachine(telemetry),
      current: runningMachine({ ...telemetry, nonce: LEASE_NONCE }),
      stopped: stoppedMachine({
        updated_at: "2026-09-03T00:00:10.123456Z",
        events: [...telemetry.events, { type: "stop", status: "stopped" }],
        checks: [{ name: "http", status: "warning" }],
      }),
      catalogs: [100, 95, 80, 75].map((free) =>
        response(200, [{ ...otherVolume, blocks_free: free, blocks_avail: free - 10 }]),
      ),
    });
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "verified_absent",
      proof: "delete_then_get_404",
    });
    expect(stops(request)).toHaveLength(1);
    expect(machineDeletes(request)).toHaveLength(1);
  });

  it("does not stop or wait on an already stopped machine", async () => {
    const request = deletionRequest();
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe(
      "verified_absent",
    );
    expect(
      request.mock.calls.some(([call]) => call.resource === "stop" || call.resource === "wait"),
    ).toBe(false);
  });

  it.each(["starting", "stopping", "suspended", "running", "destroyed", undefined, null])(
    "never stops or deletes an ambiguous initial state %j",
    async (state) => {
      const machine = runningMachine({ state });
      const request = runningRequest({ initial: machine, current: machine });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(stops(request)).toEqual([]);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each([undefined, null, "", "bad?version", "A".repeat(27), 123])(
    "never stops without an exact valid instance version: %j",
    async (instance_id) => {
      const machine = runningMachine({ instance_id });
      const request = runningRequest({ initial: machine, current: machine });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "provider_response_invalid",
        retryable: false,
      });
      expect(stops(request)).toEqual([]);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each([undefined, null, true, "false"])(
    "never stops an ambiguous auto_destroy setting %j",
    async (auto_destroy) => {
      const machine = runningMachine({
        config: { env: { PROJECT_ID: String(PROJECT_ID) }, mounts: [], auto_destroy },
      });
      const request = runningRequest({ initial: machine, current: machine });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(stops(request)).toEqual([]);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each(["initial", "under lease"])(
    "never stops a Project 51 identity mismatch %s",
    async (stage) => {
      const protectedMachine = runningMachine({
        name: "project-51",
        config: { env: { PROJECT_ID: "51" }, mounts: [], auto_destroy: false },
      });
      const request = runningRequest(
        stage === "initial" ? { initial: protectedMachine } : { current: protectedMachine },
      );
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(stops(request)).toEqual([]);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it("does not accept Project 51 authority for another project's machine", async () => {
    const request = runningRequest();
    expect(
      (await reconcileLegacyFlyRuntime({ ...authorizedInput(), projectId: 51 }, request)).state,
    ).toBe("retained");
    expect(stops(request)).toEqual([]);
  });

  const drift: Array<[string, Record<string, unknown>]> = [
    ["machine ID", { id: "another-machine" }],
    ["project name", { name: "project-51" }],
    ["nested owner", { metadata: { project_id: "51" } }],
    ["instance version", { instance_id: "B".repeat(26) }],
    [
      "config",
      {
        config: {
          env: { PROJECT_ID: String(PROJECT_ID), EXTRA: "changed" },
          mounts: [],
          auto_destroy: false,
        },
      },
    ],
    [
      "attached mount",
      {
        config: {
          env: { PROJECT_ID: String(PROJECT_ID) },
          mounts: [{ volume: "vol_data" }],
          auto_destroy: false,
        },
      },
    ],
    ["dotted mount alias", { "config.mounts": ["vol_hidden"] }],
    ["nonce mismatch", { nonce: "another-lease" }],
    ["unknown state alias", { State: "stopped" }],
    ["unknown update alias", { updatedAt: "2026-09-03T00:00:10Z" }],
    ["malformed events", { events: { ignored: true } }],
    ["nested project in events", { events: [{ project_id: "51" }] }],
    ["nested storage in checks", { checks: [{ volume: "vol_hidden" }] }],
    ["malformed timestamp", { updated_at: { value: "2026-09-03T00:00:10Z" } }],
  ];

  it.each(drift)("never stops after under-lease %s drift", async (_label, extra) => {
    const request = runningRequest({ current: runningMachine({ nonce: LEASE_NONCE, ...extra }) });
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    expect(stops(request)).toEqual([]);
    expect(machineDeletes(request)).toEqual([]);
  });

  it.each(drift)("never deletes after post-stop %s drift", async (_label, extra) => {
    const request = runningRequest({ stopped: stoppedMachine(extra) });
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    expect(stops(request)).toHaveLength(1);
    expect(machineDeletes(request)).toEqual([]);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ resource: "lease", method: "DELETE" });
  });

  it.each(["started", "starting", "stopping", "suspended", undefined, null])(
    "does not trust wait success when the observed state is %j",
    async (state) => {
      const request = runningRequest({ stopped: stoppedMachine({ state }) });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(stops(request)).toHaveLength(1);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each([202, 400, 404, 409, 429, 503])(
    "does not retry STOP or proceed after refusal %s",
    async (status) => {
      const request = runningRequest({ stop: response(status, { secret: "provider-private" }) });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "provider_delete_unavailable",
        retryable: true,
      });
      expect(stops(request)).toHaveLength(1);
      expect(request.mock.calls.some(([call]) => call.resource === "wait")).toBe(false);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each([202, 404, 408, 409, 503])(
    "retains after a bounded wait refusal/timeout %s",
    async (status) => {
      const request = runningRequest({ wait: response(status, { secret: "provider-private" }) });
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "provider_observation_unavailable",
        retryable: true,
      });
      expect(stops(request)).toHaveLength(1);
      expect(request.mock.calls.filter(([call]) => call.resource === "wait")).toHaveLength(1);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it.each(["stop", "wait", "stoppedObservation"] as const)(
    "sanitizes %s transport timeouts and releases the lease",
    async (stage) => {
      const request = runningRequest({
        [stage]: new Error("TimeoutError: provider-private " + LEASE_NONCE),
      });
      const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
      expect(result).toEqual({
        state: "retained",
        reason:
          stage === "stop" ? "provider_delete_unavailable" : "provider_observation_unavailable",
        retryable: true,
      });
      expect(JSON.stringify(result)).not.toMatch(/provider-private|private-test/u);
      expect(stops(request)).toHaveLength(1);
      expect(machineDeletes(request)).toEqual([]);
      expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ resource: "lease", method: "DELETE" });
    },
  );

  it.each([404, 503])(
    "does not infer stopped state or absence from a post-wait GET %s",
    async (status) => {
      const request = runningRequest({ stoppedObservation: response(status) });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  const unsafeCatalogs: Array<[string, () => Response]> = [
    ["unavailable", () => response(503)],
    ["detached volume", () => response(200, [{ id: "vol_data", attached_machine_id: null }])],
    ["attached volume", () => response(200, [{ id: "vol_data", attached_machine_id: MACHINE_ID }])],
    [
      "attachment alias",
      () =>
        response(200, [{ id: "vol_data", attached_machine_id: "other", attachment: MACHINE_ID }]),
    ],
  ];
  describe.each([0, 1, 2])("unsafe catalog at observation %s", (index) => {
    it.each(unsafeCatalogs)("blocks %s before the next mutation", async (_label, catalog) => {
      const catalogs = [response(200, []), response(200, []), response(200, [])];
      catalogs[index] = catalog();
      const request = runningRequest({ catalogs });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(stops(request)).toHaveLength(index === 2 ? 1 : 0);
      expect(machineDeletes(request)).toEqual([]);
    });
  });

  it("retains a changed safe volume catalog after STOP", async () => {
    const request = runningRequest({
      catalogs: [
        response(200, []),
        response(200, []),
        response(200, [{ id: "vol_new", attached_machine_id: "another-machine" }]),
      ],
    });
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    expect(machineDeletes(request)).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "propagates durable authority loss at running-path assertion %s",
    async (lostAt) => {
      const input = authorizedInput();
      const request = runningRequest();
      input.assertAuthority.mockImplementation(async () => {
        if (input.assertAuthority.mock.calls.length === lostAt) throw new Error("authority_lost");
      });
      await expect(reconcileLegacyFlyRuntime(input, request)).rejects.toThrow("authority_lost");
      expect(stops(request)).toHaveLength(lostAt <= 2 ? 0 : 1);
      expect(machineDeletes(request)).toHaveLength(lostAt === 6 ? 1 : 0);
      if (lostAt > 1)
        expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
          resource: "lease",
          method: "DELETE",
        });
    },
  );

  it.each([2, 3, 4, 5])(
    "checks Fly expiry after authority assertion %s before any next mutation",
    async (expiresAtAssertion) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const input = authorizedInput();
        const request = runningRequest();
        input.assertAuthority.mockImplementation(async () => {
          if (input.assertAuthority.mock.calls.length === expiresAtAssertion)
            clock.mockReturnValue(now + 301_000);
        });
        expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
          state: "retained",
          reason: "provider_observation_unavailable",
          retryable: true,
        });
        expect(stops(request)).toHaveLength(expiresAtAssertion === 2 ? 0 : 1);
        expect(request.mock.calls.filter(([call]) => call.resource === "wait")).toHaveLength(
          expiresAtAssertion > 3 ? 1 : 0,
        );
        expect(machineDeletes(request)).toEqual([]);
        expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
          resource: "lease",
          method: "DELETE",
        });
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([-1, 10])(
    "never stops with an expired or short acquired lease (%s seconds)",
    async (seconds) => {
      const request = runningRequest({
        lease: leaseResponse({ expires_at: Math.floor(Date.now() / 1_000) + seconds }),
      });
      expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
      expect(stops(request)).toEqual([]);
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it("does not force DELETE or stop again if the provider refuses deletion after stopped proof", async () => {
    const request = runningRequest({ deletion: response(409) });
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason: "provider_delete_unavailable",
      retryable: true,
    });
    expect(stops(request)).toHaveLength(1);
    expect(machineDeletes(request).map(([call]) => call)).toEqual([
      { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
    ]);
  });
});

describe("legacy Fly runtime reconciliation", () => {
  it("requires a safe catalog and fresh exact GET 404 for initial absence", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(404));

    await expect(reconcileLegacyFlyRuntime(authorizedInput(), request)).resolves.toEqual({
      state: "verified_absent",
      proof: "initial_get_404",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith({ machineId: MACHINE_ID, method: "GET" });
  });

  it.each(["explicit", "omitted"])(
    "proves zero volumes with %s mounts before ordinary deletion",
    async (mounts) => {
      const machine =
        mounts === "omitted"
          ? ownedMachine({ config: { env: { PROJECT_ID: String(PROJECT_ID) } } })
          : ownedMachine();
      const request = vi
        .fn<LegacyFlyRetirementRequest>()
        .mockResolvedValueOnce(response(200, machine))
        .mockResolvedValueOnce(response(200, []))
        .mockResolvedValueOnce(leaseResponse())
        .mockResolvedValueOnce(response(200, machine))
        .mockResolvedValueOnce(response(200, []))
        .mockResolvedValueOnce(response(204))
        .mockResolvedValueOnce(response(404))
        .mockResolvedValueOnce(response(200, []))
        .mockResolvedValueOnce(response(204));

      await expect(reconcileLegacyFlyRuntime(authorizedInput(), request)).resolves.toEqual({
        state: "verified_absent",
        proof: "delete_then_get_404",
      });
      expect(request.mock.calls.map(([call]) => call)).toEqual([
        { machineId: MACHINE_ID, method: "GET" },
        { resource: "volumes", method: "GET" },
        {
          resource: "lease",
          machineId: MACHINE_ID,
          method: "POST",
          description: "Legacy runtime retirement",
          ttl: 300,
        },
        { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
        { resource: "volumes", method: "GET" },
        { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
        { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
        { resource: "volumes", method: "GET" },
        { resource: "lease", machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
      ]);
    },
  );

  it.each([
    ["machine id", ownedMachine({ id: "another-machine" }), "machine_identity_mismatch"],
    ["machine name", ownedMachine({ name: "project-78" }), "project_identity_mismatch"],
    [
      "required project environment",
      ownedMachine({ config: { env: { PROJECT_ID: "78" }, mounts: [] } }),
      "project_identity_mismatch",
    ],
    [
      "contradictory metadata",
      ownedMachine({
        config: {
          env: { PROJECT_ID: String(PROJECT_ID) },
          mounts: [],
          metadata: { nabu_project_id: "78" },
        },
      }),
      "contradictory_identity_marker",
    ],
    [
      "attached volume",
      ownedMachine({
        config: {
          env: { PROJECT_ID: String(PROJECT_ID) },
          mounts: [{ volume: "vol_secret" }],
        },
      }),
      "storage_ownership_ambiguous",
    ],
    [
      "null mount inventory",
      ownedMachine({ config: { env: { PROJECT_ID: String(PROJECT_ID) }, mounts: null } }),
      "storage_ownership_ambiguous",
    ],
    [
      "unknown volume marker",
      ownedMachine({ volume_id: "vol_secret" }),
      "storage_ownership_ambiguous",
    ],
  ])("retains the pointer without DELETE for %s ambiguity", async (_label, body, reason) => {
    const request = vi.fn<LegacyFlyRetirementRequest>().mockResolvedValue(response(200, body));

    await expect(reconcileLegacyFlyRuntime(authorizedInput(), request)).resolves.toEqual({
      state: "retained",
      reason,
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["bad/id", "machine id", "?force=true", ""])(
    "retains malformed pointer %j without any provider access",
    async (machineId) => {
      const request = vi.fn<LegacyFlyRetirementRequest>();

      await expect(
        reconcileLegacyFlyRuntime({ ...authorizedInput(), machineId }, request),
      ).resolves.toEqual({
        state: "retained",
        reason: "legacy_pointer_malformed",
        retryable: false,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("retains the pointer when DELETE is not followed by a GET 404", async () => {
    const secret = "provider-secret-body";
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(leaseResponse())
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(202, { secret }))
      .mockResolvedValueOnce(response(200, { id: MACHINE_ID, secret }));

    const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);

    expect(result).toEqual({ state: "retained", reason: "absence_unverified", retryable: true });
    expect(JSON.stringify(result)).not.toContain(MACHINE_ID);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("sanitizes provider failures and never returns raw response details", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockRejectedValue(new Error(`token=secret machine=${MACHINE_ID}`));

    const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);

    expect(result).toEqual({
      state: "retained",
      reason: "provider_observation_unavailable",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|9080e521b67587/u);
  });

  it.each([
    ["attached volume", response(200, [{ id: "vol_owned", attached_machine_id: MACHINE_ID }])],
    ["detached volume", response(200, [{ id: "vol_detached", attached_machine_id: null }])],
    ["empty relationship", response(200, [{ id: "vol_empty", attached_machine_id: "" }])],
    [
      "attachment alias",
      response(200, [
        { id: "vol_other", attached_machine_id: "other-machine", attachment: MACHINE_ID },
      ]),
    ],
    [
      "attach alias",
      response(200, [{ id: "vol_other", attached_machine_id: "other-machine", attach: [] }]),
    ],
    ["unavailable inventory", response(503, [])],
    ["partial response", response(206, [])],
    ["paginated envelope", response(200, { volumes: [], next_cursor: "more" })],
    ["missing attachment field", response(200, [{ id: "vol_unknown" }])],
    ["malformed attachment", response(200, [{ id: "vol_unknown", attached_machine_id: 42 }])],
    [
      "legacy allocation",
      response(200, [
        { id: "vol_unknown", attached_machine_id: null, attached_alloc_id: "legacy" },
      ]),
    ],
    [
      "contradictory attachment alias",
      response(200, [{ id: "vol_unknown", attached_machine_id: null, machine_id: MACHINE_ID }]),
    ],
    [
      "duplicate volume",
      response(200, [
        { id: "vol_same", attached_machine_id: "other-machine" },
        { id: "vol_same", attached_machine_id: "other-machine" },
      ]),
    ],
    ["pagination link", response(200, [], { link: '</volumes?page=2>; rel="next"' })],
    ["incomplete count", response(200, [], { "x-total-count": "1" })],
    ["missing body", response(200)],
    [
      "catalog limit",
      response(
        200,
        Array.from({ length: 1_000 }, (_, index) => ({
          id: `vol_${index}`,
          attached_machine_id: null,
        })),
      ),
    ],
  ])("never deletes with %s", async (_label, catalogResponse) => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(
        response(200, ownedMachine({ config: { env: { PROJECT_ID: String(PROJECT_ID) } } })),
      )
      .mockResolvedValueOnce(catalogResponse as Awaited<ReturnType<LegacyFlyRetirementRequest>>);

    await expect(reconcileLegacyFlyRuntime(authorizedInput(), request)).resolves.toEqual({
      state: "retained",
      reason: "storage_ownership_ambiguous",
      retryable: false,
    });
    expect(
      request.mock.calls.some(([input]) => input.method === "DELETE" && input.resource !== "lease"),
    ).toBe(false);
  });

  it("blocks a failed catalog request and malformed catalog JSON", async () => {
    for (const malformedJson of [false, true]) {
      const request = vi
        .fn<LegacyFlyRetirementRequest>()
        .mockResolvedValueOnce(response(200, ownedMachine()));
      if (malformedJson) {
        request.mockResolvedValueOnce(new Response("{", { status: 200 }));
      } else {
        request.mockRejectedValueOnce(new Error("provider-secret"));
      }
      const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
      expect(result).toEqual({
        state: "retained",
        reason: "storage_ownership_ambiguous",
        retryable: false,
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain("provider-secret");
    }
  });

  it("allows unrelated fully described volumes without deleting any volume", async () => {
    const volumes = [
      { id: "vol_other", attached_machine_id: "other-machine", attached_alloc_id: null },
    ];
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, volumes))
      .mockResolvedValueOnce(leaseResponse())
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, volumes))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, volumes))
      .mockResolvedValueOnce(response(204));
    await expect(reconcileLegacyFlyRuntime(authorizedInput(), request)).resolves.toEqual({
      state: "verified_absent",
      proof: "delete_then_get_404",
    });
    expect(
      request.mock.calls
        .filter(([input]) => input.method === "DELETE" && input.resource !== "lease")
        .map(([input]) => input),
    ).toEqual([{ machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE }]);
  });

  it.each([
    ["machine changed", ownedMachine({ state: "changed" }), response(200, [])],
    ["machine identity changed", ownedMachine({ id: "another-machine" }), response(200, [])],
    ["project marker changed", ownedMachine({ name: "project-78" }), response(200, [])],
    [
      "volume appeared",
      ownedMachine(),
      response(200, [{ id: "vol_new", attached_machine_id: null }]),
    ],
    [
      "volume attached",
      ownedMachine(),
      response(200, [{ id: "vol_new", attached_machine_id: MACHINE_ID }]),
    ],
    ["catalog became unavailable", ownedMachine(), response(503, [])],
  ])("blocks deletion when the second observation has %s", async (_label, machine, catalog) => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(leaseResponse())
      .mockResolvedValueOnce(response(200, machine))
      .mockResolvedValueOnce(catalog as Awaited<ReturnType<LegacyFlyRetirementRequest>>);
    const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
    expect(result.state).toBe("retained");
    expect(
      request.mock.calls.some(([input]) => input.method === "DELETE" && input.resource !== "lease"),
    ).toBe(false);
  });

  it("does not upgrade a changed machine observation to initial-404 success", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(leaseResponse())
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(204));
    expect((await reconcileLegacyFlyRuntime(authorizedInput(), request)).state).toBe("retained");
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("keeps an ordinary provider-delete refusal blocked", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(leaseResponse())
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(409));
    await expect(reconcileLegacyFlyRuntime(authorizedInput(), request)).resolves.toEqual({
      state: "retained",
      reason: "provider_delete_unavailable",
      retryable: true,
    });
    expect(request).toHaveBeenCalledTimes(7);
  });
});

describe("legacy Fly lease metadata and volume usage compatibility", () => {
  function compatibilityRequest(machines: [unknown, unknown], catalogs: unknown[] = [[], [], []]) {
    let machineReads = 0;
    let catalogReads = 0;
    return vi.fn<LegacyFlyRetirementRequest>().mockImplementation(async (call) => {
      if (call.resource === "lease") {
        return call.method === "POST" ? leaseResponse() : response(204);
      }
      if (call.resource === "volumes") return response(200, catalogs[catalogReads++]);
      if (call.method === "DELETE") return response(204);
      const machine = machines[machineReads++];
      return machine === undefined ? response(404) : response(200, machine);
    });
  }

  const otherVolume = {
    id: "vol_other",
    name: "other-data",
    attached_machine_id: "other-machine",
    attached_alloc_id: null,
    region: "iad",
    zone: "other-zone",
    size_gb: 10,
    encrypted: true,
    blocks: 2_621_440,
    block_size: 4_096,
    blocks_free: 2_000,
    blocks_avail: 1_900,
    metadata: { owner: "other-owner" },
  };

  it.each([
    ["appears after acquisition", {}, { nonce: LEASE_NONCE }],
    ["matches in both observations", { nonce: LEASE_NONCE }, { nonce: LEASE_NONCE }],
    ["is omitted after acquisition", { nonce: LEASE_NONCE }, {}],
  ])("accepts a top-level nonce that %s", async (_label, before, after) => {
    const request = compatibilityRequest([ownedMachine(before), ownedMachine(after)]);
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "verified_absent",
      proof: "delete_then_get_404",
    });
    expect(machineDeletes(request).map(([call]) => call)).toEqual([
      { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
    ]);
    expect(request).toHaveBeenCalledTimes(9);
  });

  const invalidNonces: Array<[string, unknown]> = [
    ["mismatched", "different-lease"],
    ["empty", ""],
    ["whitespace", "bad nonce"],
    ["control characters", "bad\r\nnonce"],
    ["non-ASCII", "\u00e9"],
    ["oversized", "x".repeat(257)],
    ["null", null],
    ["number", 123],
    ["boolean", false],
    ["object", { value: LEASE_NONCE }],
    ["array", [LEASE_NONCE]],
  ];
  describe.each(["initial", "under lease"])("%s machine nonce", (stage) => {
    it.each(invalidNonces)("rejects a %s nonce", async (label, nonce) => {
      const request = compatibilityRequest([
        ownedMachine(stage === "initial" ? { nonce } : {}),
        ownedMachine(stage === "under lease" ? { nonce } : { nonce: LEASE_NONCE }),
      ]);
      const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
      expect(result).toEqual({
        state: "retained",
        reason: "provider_response_invalid",
        retryable: false,
      });
      expect(machineDeletes(request)).toEqual([]);
      if (stage === "under lease" || label === "mismatched") {
        expect(request.mock.calls.at(-1)?.[0]).toEqual({
          resource: "lease",
          machineId: MACHINE_ID,
          method: "DELETE",
          leaseNonce: LEASE_NONCE,
        });
      } else {
        expect(request).toHaveBeenCalledTimes(1);
      }
      expect(JSON.stringify(result)).not.toContain(LEASE_NONCE);
    });
  });

  const machineChanges: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> =
    [
      ["machine ID", {}, { id: "another-machine" }, "machine_identity_mismatch"],
      ["project name", {}, { name: "project-" + (PROJECT_ID + 1) }, "project_identity_mismatch"],
      [
        "project environment",
        {},
        { config: { env: { PROJECT_ID: String(PROJECT_ID + 1) }, mounts: [] } },
        "project_identity_mismatch",
      ],
      [
        "nested ownership marker",
        {},
        { metadata: { project_id: String(PROJECT_ID + 1) } },
        "contradictory_identity_marker",
      ],
      [
        "config",
        {},
        { config: { env: { PROJECT_ID: String(PROJECT_ID), EXTRA: "changed" }, mounts: [] } },
        "storage_ownership_ambiguous",
      ],
      [
        "config nonce",
        { config: { env: { PROJECT_ID: String(PROJECT_ID) }, mounts: [], nonce: "before" } },
        { config: { env: { PROJECT_ID: String(PROJECT_ID) }, mounts: [], nonce: "after" } },
        "storage_ownership_ambiguous",
      ],
      [
        "metadata nonce",
        { metadata: { nonce: "before" } },
        { metadata: { nonce: "after" } },
        "storage_ownership_ambiguous",
      ],
      [
        "nonce casing alias",
        { Nonce: "before" },
        { Nonce: "after" },
        "storage_ownership_ambiguous",
      ],
      [
        "dotted nonce alias",
        { "config.nonce": "before" },
        { "config.nonce": "after" },
        "storage_ownership_ambiguous",
      ],
    ];
  it.each(machineChanges)(
    "retains %s drift despite a matching lease nonce",
    async (_label, before, after, reason) => {
      const request = compatibilityRequest([
        ownedMachine(before),
        ownedMachine({ ...after, nonce: LEASE_NONCE }),
      ]);
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason,
        retryable: false,
      });
      expect(machineDeletes(request)).toEqual([]);
    },
  );

  it("allows usage counter changes before and after deletion with a newly observed nonce", async () => {
    const request = compatibilityRequest(
      [ownedMachine(), ownedMachine({ nonce: LEASE_NONCE })],
      [
        [otherVolume],
        [{ ...otherVolume, blocks_free: 1_990, blocks_avail: 1_880 }],
        [{ ...otherVolume, blocks_free: 0, blocks_avail: 0 }],
      ],
    );
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "verified_absent",
      proof: "delete_then_get_404",
    });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      { machineId: MACHINE_ID, method: "GET" },
      { resource: "volumes", method: "GET" },
      {
        resource: "lease",
        machineId: MACHINE_ID,
        method: "POST",
        description: "Legacy runtime retirement",
        ttl: 300,
      },
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
      { resource: "volumes", method: "GET" },
      { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
      { resource: "volumes", method: "GET" },
      { resource: "lease", machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
    ]);
  });

  const volumeChanges: Array<[string, Record<string, unknown>]> = [
    ["volume ID", { id: "vol_changed" }],
    ["name", { name: "changed-data" }],
    ["region", { region: "ord" }],
    ["zone", { zone: "changed-zone" }],
    ["capacity", { size_gb: 20 }],
    ["encryption", { encrypted: false }],
    ["total blocks", { blocks: 5_242_880 }],
    ["block size", { block_size: 8_192 }],
    ["ownership metadata", { metadata: { owner: "changed-owner" } }],
    ["attachment to another machine", { attached_machine_id: "third-machine" }],
    ["attachment to the retired machine", { attached_machine_id: MACHINE_ID }],
    ["detachment", { attached_machine_id: null }],
    ["allocation attachment", { attached_alloc_id: "some-allocation" }],
    ["attachment alias", { attachedMachineId: "hidden-machine" }],
    ["nested attachment", { metadata: { attached_machine_id: "hidden-machine" } }],
    ["unknown project marker", { project_id: String(PROJECT_ID) }],
    ["counter alias", { blocksFree: 1_990 }],
    ["nested free counter", { metadata: { owner: "other-owner", blocks_free: 1_990 } }],
    ["nested available counter", { metadata: { owner: "other-owner", blocks_avail: 1_880 } }],
  ];
  for (const counter of ["blocks_free", "blocks_avail"]) {
    for (const value of [
      null,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      "1990",
      [],
      { owner: "hidden" },
    ]) {
      volumeChanges.push([
        "malformed " + counter + ": " + JSON.stringify(value),
        { [counter]: value },
      ]);
    }
    volumeChanges.push([
      "relationship inside " + counter,
      { [counter]: { attached_machine_id: "hidden-machine" } },
    ]);
  }
  describe.each(["before deletion", "after deletion"])("volume changes %s", (stage) => {
    it.each(volumeChanges)("blocks %s despite mutable counter changes", async (_label, change) => {
      const changedVolume = { ...otherVolume, blocks_free: 1_990, blocks_avail: 1_880, ...change };
      const request = compatibilityRequest(
        [ownedMachine(), ownedMachine({ nonce: LEASE_NONCE })],
        [
          [otherVolume],
          [stage === "before deletion" ? changedVolume : otherVolume],
          [changedVolume],
        ],
      );
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "storage_ownership_ambiguous",
        retryable: false,
      });
      expect(machineDeletes(request)).toHaveLength(stage === "before deletion" ? 0 : 1);
      expect(request.mock.calls.at(-1)?.[0]).toEqual({
        resource: "lease",
        machineId: MACHINE_ID,
        method: "DELETE",
        leaseNonce: LEASE_NONCE,
      });
    });
  });
});

describe("legacy Fly lease and authority hardening", () => {
  it.each([
    ["detached storage", () => response(200, [{ id: "vol_detached", attached_machine_id: null }])],
    [
      "attached storage",
      () => response(200, [{ id: "vol_owned", attached_machine_id: MACHINE_ID }]),
    ],
    ["unavailable catalog", () => response(503)],
    ["invalid catalog", () => new Response("{", { status: 200 })],
  ])("blocks initial 404 with %s", async (_label, catalog) => {
    const input = authorizedInput();
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(catalog());
    expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
      state: "retained",
      reason: "storage_ownership_ambiguous",
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(input.assertAuthority).not.toHaveBeenCalled();
  });

  it("does not accept an initial 404 when the fresh machine is present", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, ownedMachine()));
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason: "absence_unverified",
      retryable: true,
    });
  });

  it.each([
    ["dotted mount key", { "config.mounts": ["vol_hidden"] }, "storage_ownership_ambiguous"],
    ["attachment key", { attached: null }, "storage_ownership_ambiguous"],
    [
      "malformed project marker",
      { metadata: { project_id: { toString: {}, valueOf: {} } } },
      "contradictory_identity_marker",
    ],
  ])("sanitizes %s without acquiring a lease", async (_label, extra, reason) => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine(extra as Record<string, unknown>)));
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason,
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["machine", "catalog", "lease"])(
    "bounds decoded %s bytes before JSON parsing",
    async (stage) => {
      const payload = '"' + "x".repeat(1_048_576) + '"';
      const cancel = vi.fn();
      const oversized = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
          },
          cancel,
        }),
        {
          status: stage === "lease" ? 201 : 200,
          headers: { "content-length": "1", "content-encoding": "gzip" },
        },
      );
      const request = vi.fn<LegacyFlyRetirementRequest>();
      if (stage !== "machine") request.mockResolvedValueOnce(response(200, ownedMachine()));
      if (stage === "lease") request.mockResolvedValueOnce(response(200, []));
      request.mockResolvedValueOnce(oversized);
      const parse = vi.spyOn(JSON, "parse");
      try {
        const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
        expect(result.state).toBe("retained");
        expect(parse).not.toHaveBeenCalledWith(payload);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(machineDeletes(request)).toEqual([]);
      } finally {
        parse.mockRestore();
      }
    },
  );

  it.each(["depth", "nodes"])("bounds provider document %s", async (kind) => {
    let metadata: unknown = Array.from({ length: 16_384 }, () => null);
    if (kind === "depth") {
      metadata = null;
      for (let depth = 0; depth < 34; depth++) metadata = { child: metadata };
    }
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine({ metadata })));
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason: "provider_response_invalid",
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sanitizes malformed machine JSON and fingerprint failures", async () => {
    const malformed = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(new Response("{provider-secret", { status: 200 }));
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), malformed)).toEqual({
      state: "retained",
      reason: "provider_response_invalid",
      retryable: false,
    });
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()));
    const fingerprint = vi.spyOn(Object, "fromEntries").mockImplementationOnce(() => {
      throw new Error("provider-secret");
    });
    try {
      expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
        state: "retained",
        reason: "provider_response_invalid",
        retryable: false,
      });
    } finally {
      fingerprint.mockRestore();
    }
  });

  it.each([409, 503])("retains a lease acquisition refusal %s without retry", async (status) => {
    const request = deletionRequest({ lease: response(status) });
    const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
    expect(result).toEqual({
      state: "retained",
      reason: "provider_observation_unavailable",
      retryable: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(machineDeletes(request)).toEqual([]);
  });

  it.each([
    ["invalid nonce", () => ({ nonce: "bad\r\nnonce" }), false],
    ["expired lease", () => ({ expires_at: Math.floor(Date.now() / 1_000) - 1 }), true],
    ["short lease", () => ({ expires_at: Math.floor(Date.now() / 1_000) + 10 }), true],
    ["unbounded expiry", () => ({ expires_at: Math.floor(Date.now() / 1_000) + 3_600 }), true],
    ["missing version", () => ({ version: null }), true],
  ])("blocks %s and releases any usable nonce", async (_label, data, release) => {
    const request = deletionRequest({ lease: leaseResponse(data()) });
    const result = await reconcileLegacyFlyRuntime(authorizedInput(), request);
    expect(result.state).toBe("retained");
    expect(machineDeletes(request)).toEqual([]);
    expect(
      request.mock.calls.some(([call]) => call.resource === "lease" && call.method === "DELETE"),
    ).toBe(release);
    expect(JSON.stringify(result)).not.toContain(LEASE_NONCE);
  });

  it("sends the nonce on every under-lease machine call and releases before terminal authority", async () => {
    const input = authorizedInput();
    const request = deletionRequest();
    input.assertAuthority.mockImplementation(async () => {
      if (input.assertAuthority.mock.calls.length === 3) {
        expect(request.mock.calls.at(-1)?.[0]).toEqual({
          resource: "lease",
          machineId: MACHINE_ID,
          method: "DELETE",
          leaseNonce: LEASE_NONCE,
        });
      }
    });
    const result = await reconcileLegacyFlyRuntime(input, request);
    expect(result).toEqual({ state: "verified_absent", proof: "delete_then_get_404" });
    expect(input.assertAuthority).toHaveBeenCalledTimes(3);
    expect(
      request.mock.calls
        .slice(3)
        .filter(([call]) => !call.resource)
        .map(([call]) => call),
    ).toEqual([
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
      { machineId: MACHINE_ID, method: "DELETE", leaseNonce: LEASE_NONCE },
      { machineId: MACHINE_ID, method: "GET", leaseNonce: LEASE_NONCE },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private-test|test-owner|test-version/u);
  });

  it("fails closed without an authority callback before provider access", async () => {
    const request = vi.fn<LegacyFlyRetirementRequest>();
    const input = { machineId: MACHINE_ID, projectId: PROJECT_ID } as Parameters<
      typeof reconcileLegacyFlyRuntime
    >[0];
    expect(await reconcileLegacyFlyRuntime(input, request)).toEqual({
      state: "retained",
      reason: "provider_observation_unavailable",
      retryable: true,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("propagates authority loss at assertion %s", async (lostAt) => {
    const input = authorizedInput();
    const request = deletionRequest();
    input.assertAuthority.mockImplementation(async () => {
      if (input.assertAuthority.mock.calls.length === lostAt) throw new Error("authority_lost");
    });
    await expect(reconcileLegacyFlyRuntime(input, request)).rejects.toThrow("authority_lost");
    expect(machineDeletes(request)).toHaveLength(lostAt === 3 ? 1 : 0);
    expect(
      request.mock.calls.filter(([call]) => call.resource === "lease" && call.method === "POST"),
    ).toHaveLength(lostAt === 1 ? 0 : 1);
    expect(
      request.mock.calls.filter(([call]) => call.resource === "lease" && call.method === "DELETE"),
    ).toHaveLength(lostAt === 1 ? 0 : 1);
  });

  it("requires authority before returning initial absence", async () => {
    const input = authorizedInput();
    input.assertAuthority.mockRejectedValue(new Error("authority_lost"));
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(404));
    await expect(reconcileLegacyFlyRuntime(input, request)).rejects.toThrow("authority_lost");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("checks remaining lease lifetime after the final authority assertion before DELETE", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const input = authorizedInput();
      const request = deletionRequest();
      input.assertAuthority.mockImplementation(async () => {
        if (input.assertAuthority.mock.calls.length === 2) clock.mockReturnValue(now + 280_000);
      });
      expect((await reconcileLegacyFlyRuntime(input, request)).state).toBe("retained");
      expect(machineDeletes(request)).toEqual([]);
      expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ resource: "lease", method: "DELETE" });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["detached volume", () => response(200, [{ id: "vol_detached", attached_machine_id: null }])],
    ["unavailable catalog", () => response(503)],
    [
      "changed safe catalog",
      () => response(200, [{ id: "vol_new", attached_machine_id: "other-machine" }]),
    ],
  ])("requires fresh matching storage proof after DELETE: %s", async (_label, finalCatalog) => {
    const request = deletionRequest({ finalCatalog: finalCatalog() });
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason: "storage_ownership_ambiguous",
      retryable: false,
    });
    expect(machineDeletes(request)).toHaveLength(1);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ resource: "lease", method: "DELETE" });
  });

  it.each([409, 503])("never retries or forces a refused machine DELETE %s", async (status) => {
    const request = deletionRequest({ deletion: response(status) });
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason: "provider_delete_unavailable",
      retryable: true,
    });
    expect(machineDeletes(request)).toHaveLength(1);
    expect(machineDeletes(request)[0]?.[0]).toEqual({
      machineId: MACHINE_ID,
      method: "DELETE",
      leaseNonce: LEASE_NONCE,
    });
  });

  it("releases its lease once after a transport failure without leaking provider errors", async () => {
    const request = deletionRequest();
    request
      .mockReset()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(leaseResponse())
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(200, []))
      .mockRejectedValueOnce(new Error("provider-secret"))
      .mockRejectedValueOnce(new Error("release-secret"));
    expect(await reconcileLegacyFlyRuntime(authorizedInput(), request)).toEqual({
      state: "retained",
      reason: "provider_delete_unavailable",
      retryable: true,
    });
    expect(machineDeletes(request)).toHaveLength(1);
    expect(
      request.mock.calls.filter(([call]) => call.resource === "lease" && call.method === "DELETE"),
    ).toHaveLength(1);
  });
});
