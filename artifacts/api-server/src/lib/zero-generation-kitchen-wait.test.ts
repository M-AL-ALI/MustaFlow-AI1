import { describe, expect, it } from "vitest";
import {
  ZERO_GENERATION_ASSEMBLY_RESERVE_MS,
  ZERO_GENERATION_COMMIT_RESERVE_MS,
  ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS,
  ZERO_GENERATION_OBSERVATION_RESERVE_MS,
  ZERO_GENERATION_START_RESERVE_MS,
  ZERO_SEALED_BUILD_PLATFORM,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
} from "@workspace/tenant-runtime-contracts";
import {
  ZeroGenerationKitchenError,
  waitForPantryShelf,
  zeroGenerationReservedOperationTimeout,
} from "./zero-generation-kitchen";

const assemblyId = `passembly_${"a".repeat(64)}`;
const shelfRootSha256 = "b".repeat(64);

async function stockRequest(offsetMs = 0) {
  const identity = {
    intents: [{ ecosystem: "npm" as const, name: "express", selector: "^5.1.0" }],
    platform: ZERO_SEALED_BUILD_PLATFORM,
  };
  const requestedAt = new Date(Date.parse("2026-08-09T16:00:00.000Z") + offsetMs);
  return pantryCatalogStockRequestSchema.parse({
    schemaVersion: 1,
    ...identity,
    requestSha256: await pantryCatalogStockRequestHash(identity),
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + 60 * 60_000).toISOString(),
  });
}

function progress(state: "queued" | "running", attempt: number) {
  return {
    ok: true as const,
    assemblyId,
    ingest:
      state === "queued"
        ? {
            state,
            attempt,
            updatedAt: "2026-08-09T16:00:00.000Z",
            leaseUntil: null,
            failure: null,
          }
        : {
            state,
            attempt,
            updatedAt: "2026-08-09T16:01:00.000Z",
            leaseUntil: "2026-08-09T16:04:00.000Z",
            failure: null,
          },
    stagedObjects: attempt,
  };
}

describe("Zero generator Pantry lifecycle waiting", () => {
  it("never hands commit or start less than its named reserve", () => {
    const productStartedAtMs = 10_000;
    const productDeadlineMs = productStartedAtMs + ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS;
    const afterAssemblyMs = productStartedAtMs + ZERO_GENERATION_ASSEMBLY_RESERVE_MS;
    expect(
      zeroGenerationReservedOperationTimeout({
        operation: "artifact-commit",
        nowMs: afterAssemblyMs,
        productDeadlineMs,
      }),
    ).toBe(ZERO_GENERATION_COMMIT_RESERVE_MS);
    expect(
      zeroGenerationReservedOperationTimeout({
        operation: "runtime-start",
        nowMs: afterAssemblyMs + ZERO_GENERATION_COMMIT_RESERVE_MS,
        productDeadlineMs,
      }),
    ).toBe(ZERO_GENERATION_START_RESERVE_MS);
    expect(() =>
      zeroGenerationReservedOperationTimeout({
        operation: "runtime-start",
        nowMs:
          productDeadlineMs -
          ZERO_GENERATION_OBSERVATION_RESERVE_MS -
          ZERO_GENERATION_START_RESERVE_MS +
          1,
        productDeadlineMs,
      }),
    ).toThrow(/named reserve/u);
  });

  it("scopes transport idempotency to one canonical identity and a fresh signed envelope", async () => {
    const first = await stockRequest();
    const resumed = await stockRequest(30_000);
    expect(resumed.requestSha256).toBe(first.requestSha256);
    const bodiesByKey = new Map<string, string>();
    const keys: string[] = [];
    const provider = {
      async zeroGenerationControlRequest(input: {
        method: "GET" | "POST";
        body?: unknown;
        idempotencyKey?: string;
      }) {
        expect(input.method).toBe("POST");
        expect(input.idempotencyKey).toContain(first.requestSha256);
        const key = input.idempotencyKey ?? "";
        const body = JSON.stringify(input.body);
        const existing = bodiesByKey.get(key);
        if (existing !== undefined && existing !== body) throw new Error("idempotency_conflict");
        bodiesByKey.set(key, body);
        keys.push(key);
        return {
          ok: true,
          state: "committed",
          assemblyId,
          revisionRootSha256: shelfRootSha256,
        };
      },
    };
    const options = {
      deadlineMs: 20 * 60_000,
      monotonicNow: () => 0,
      sleep: async () => undefined,
    };
    await expect(waitForPantryShelf(provider, first, options)).resolves.toMatchObject({
      shelfRootSha256,
    });
    await expect(waitForPantryShelf(provider, resumed, options)).resolves.toMatchObject({
      shelfRootSha256,
    });
    expect(new Set(keys).size).toBe(2);
  });

  it("allows a progressing cold stock to exceed the former 300-second private bound", async () => {
    let elapsedMs = 0;
    let stockCalls = 0;
    const provider = {
      async zeroGenerationControlRequest(input: { method: "GET" | "POST"; path?: string }) {
        if (input.method === "POST") {
          stockCalls += 1;
          return elapsedMs > 300_000
            ? {
                ok: true,
                state: "committed",
                assemblyId,
                revisionRootSha256: shelfRootSha256,
              }
            : {
                ok: true,
                state: stockCalls === 1 ? "created" : "assembling",
                assemblyId,
                revisionRootSha256: null,
              };
        }
        return progress("running", stockCalls);
      },
    };

    const result = await waitForPantryShelf(provider, await stockRequest(), {
      deadlineMs: 20 * 60_000,
      monotonicNow: () => elapsedMs,
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
    });

    expect(elapsedMs).toBeGreaterThan(300_000);
    expect(result.shelfRootSha256).toBe(shelfRootSha256);
    expect(result.lastProgress).toMatchObject({ ingestState: "running" });
  });

  it("propagates a terminal Pantry ingest failure immediately with its typed code", async () => {
    let sleeps = 0;
    const provider = {
      async zeroGenerationControlRequest(input: { method: "GET" | "POST"; path?: string }) {
        if (input.method === "POST") {
          return {
            ok: true,
            state: "assembling",
            assemblyId,
            revisionRootSha256: null,
          };
        }
        return {
          ok: true,
          assemblyId,
          ingest: {
            state: "failed",
            attempt: 1,
            updatedAt: "2026-08-09T16:01:00.000Z",
            leaseUntil: null,
            failure: {
              code: "package_not_found",
              message: "sanitized upstream failure",
              retryable: false,
              failedAt: "2026-08-09T16:01:00.000Z",
              negativeCacheUntil: "2026-08-09T16:06:00.000Z",
              stage: "registry-ingest",
              operation: "registry-ingest",
              cause: "registry-upstream",
              errorClass: null,
              errorCode: null,
              errorFingerprint: null,
            },
          },
          stagedObjects: 0,
        };
      },
    };

    await expect(
      waitForPantryShelf(provider, await stockRequest(), {
        deadlineMs: 20 * 60_000,
        monotonicNow: () => 0,
        sleep: async () => {
          sleeps += 1;
        },
      }),
    ).rejects.toMatchObject({
      name: "ZeroGenerationKitchenError",
      code: "package_not_found",
      evidence: { lastObservedProgress: { failureCode: "package_not_found" } },
    });
    expect(sleeps).toBe(0);
  });

  it("cancels cleanly while waiting for Pantry progress", async () => {
    const controller = new AbortController();
    const provider = {
      async zeroGenerationControlRequest(input: { method: "GET" | "POST" }) {
        return input.method === "POST"
          ? {
              ok: true,
              state: "assembling",
              assemblyId,
              revisionRootSha256: null,
            }
          : progress("queued", 0);
      },
    };

    await expect(
      waitForPantryShelf(provider, await stockRequest(), {
        deadlineMs: 20 * 60_000,
        monotonicNow: () => 0,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "generation_cancelled", evidence: { stage: "pantry-wait" } });
  });

  it("reports the last explicit progress state when the product bound expires", async () => {
    let elapsedMs = 0;
    let attempts = 0;
    const provider = {
      async zeroGenerationControlRequest(input: { method: "GET" | "POST"; path?: string }) {
        if (input.method === "POST") {
          return {
            ok: true,
            state: "assembling",
            assemblyId,
            revisionRootSha256: null,
          };
        }
        if (input.path?.endsWith("/diagnostics") === true) return {};
        attempts += 1;
        return progress("running", attempts);
      },
    };

    let caught: unknown;
    try {
      await waitForPantryShelf(provider, await stockRequest(), {
        deadlineMs: 10_000,
        monotonicNow: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += milliseconds;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZeroGenerationKitchenError);
    expect(caught).toMatchObject({
      code: "pantry_stock_timeout",
      evidence: {
        stage: "pantry-wait",
        elapsedMs: 10_000,
        lastObservedProgress: { ingestState: "running", attempt: 3 },
      },
    });
  });

  it("keeps outer timeout authority when the inner Pantry follower expires near the bound", async () => {
    let elapsedMs = 0;
    let stockCalls = 0;
    const provider = {
      async zeroGenerationControlRequest(input: { method: "GET" | "POST"; path?: string }) {
        if (input.method === "POST") {
          stockCalls += 1;
          if (stockCalls === 1) {
            return {
              ok: true,
              state: "assembling",
              assemblyId,
              revisionRootSha256: null,
            };
          }
          elapsedMs = 5_000;
          throw Object.assign(new Error("inner follower expired"), {
            status: 504,
            code: "pantry_operation_timeout",
            elapsedMs: 1_000,
            attempts: 2,
            lastObservedOperationState: "transport_fetch_exception_after_dispatch",
          });
        }
        if (input.path?.endsWith("/diagnostics") === true) {
          return {
            ok: true,
            assemblyId,
            requestSha256: "c".repeat(64),
            currentStage: "fetching-tarball",
            lastTransitionAt: "2026-08-09T16:01:30.000Z",
            queueEnqueues: 2,
            queueDeliveries: 7,
            generation: 2,
            leaseRenewals: 5,
            alarmReenqueues: 1,
            ingestAttempts: 2,
            stagedObjects: 0,
            metrics: {
              resolvedPackages: 3,
              fetchedTarballs: 3,
              verifiedTarballs: 2,
              extractedTarballs: 2,
              dependencyEdges: 8,
              tarballBytes: 1_024,
              unpackedBytes: 4_096,
            },
            stageTransitions: [
              {
                stage: "fetching-tarball",
                firstAt: "2026-08-09T16:01:00.000Z",
                lastAt: "2026-08-09T16:01:30.000Z",
                transitions: 3,
              },
            ],
            events: [],
            truncatedBeforeSequence: 0,
          };
        }
        return progress("running", 2);
      },
    };

    await expect(
      waitForPantryShelf(provider, await stockRequest(), {
        deadlineMs: 8_000,
        monotonicNow: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += milliseconds;
        },
      }),
    ).rejects.toMatchObject({
      name: "ZeroGenerationKitchenError",
      code: "pantry_stock_timeout",
      evidence: {
        elapsedMs: 8_000,
        lastObservedProgress: {
          currentStage: "fetching-tarball",
          queueDeliveries: 7,
          innerFollowerState: "transport_fetch_exception_after_dispatch",
        },
        innerFollower: {
          code: "pantry_operation_timeout",
          attempts: 2,
          lastObservedOperationState: "transport_fetch_exception_after_dispatch",
        },
      },
    });
  });
});
