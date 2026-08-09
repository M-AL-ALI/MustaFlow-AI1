import { describe, expect, it } from "vitest";
import { handleControlRequest } from "../src/worker";
import { MockBackend, MemoryCoordinator, TEST_NOW_MS, fakeEnv, signedRequest } from "./helpers";

describe("signed trusted-build service gateway", () => {
  it("keeps the private build plane behind signed control and assigns a trusted principal", async () => {
    const env = fakeEnv();
    const captured: Array<{ path: string; principal: string | null }> = [];
    env.TRUSTED_BUILD_PLANE = {
      async fetch(request: Request) {
        captured.push({
          path: new URL(request.url).pathname,
          principal: request.headers.get("x-nabuflow-build-principal"),
        });
        return Response.json({
          ok: true,
          service: "trusted-build-plane",
          schemaVersion: 1,
          secretlessCells: true,
          directRegistryAccess: false,
        });
      },
    } as unknown as Fetcher;
    const dependencies = {
      coordinator: new MemoryCoordinator(),
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
      requestId: "build-gateway-health",
    };
    const path = "/_nabuflow/control/v1/build-plane/health";
    expect(
      (await handleControlRequest(new Request(`https://runtime.example${path}`), env, dependencies))
        .status,
    ).toBe(401);
    expect(captured).toHaveLength(0);
    const response = await handleControlRequest(
      await signedRequest({ path, nonce: "build-gateway-health-0001" }),
      env,
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(captured).toEqual([{ path: "/internal/v1/health", principal: "build-control" }]);
  });

  it("fails closed without the private binding and preserves typed build failures", async () => {
    const coordinator = new MemoryCoordinator();
    const path = "/_nabuflow/control/v1/build-plane/builds";
    const env = fakeEnv();
    const missing = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        body: { fixture: true },
        nonce: "build-gateway-missing-0001",
        idempotencyKey: "build-gateway-missing",
      }),
      env,
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS, requestId: "missing" },
    );
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({
      code: "build_infrastructure_unavailable",
      retryable: false,
    });

    env.TRUSTED_BUILD_PLANE = {
      async fetch() {
        return Response.json(
          {
            ok: false,
            code: "build_platform_mismatch",
            message: "The build input does not match its immutable Pantry shelf",
            retryable: false,
            requestId: "private-id",
          },
          { status: 422 },
        );
      },
    } as unknown as Fetcher;
    const typed = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        body: { fixture: true },
        nonce: "build-gateway-typed-0001",
        idempotencyKey: "build-gateway-typed",
      }),
      env,
      {
        coordinator: new MemoryCoordinator(),
        backend: new MockBackend(),
        nowMs: TEST_NOW_MS,
        requestId: "typed",
      },
    );
    expect(typed.status).toBe(422);
    await expect(typed.json()).resolves.toMatchObject({
      code: "build_platform_mismatch",
      retryable: false,
      requestId: "typed",
    });
  });

  it("advertises the build capability only when its service binding is present", async () => {
    const env = fakeEnv();
    const path = "/_nabuflow/control/v1/version";
    const without = await handleControlRequest(
      await signedRequest({ path, nonce: "build-version-without-0001" }),
      env,
      {
        coordinator: new MemoryCoordinator(),
        backend: new MockBackend(),
        nowMs: TEST_NOW_MS,
      },
    );
    expect(((await without.json()) as { features: string[] }).features).not.toContain(
      "trusted-build-v1",
    );
    env.TRUSTED_BUILD_PLANE = {
      fetch: async () => Response.json({ ok: true }),
    } as unknown as Fetcher;
    const withBinding = await handleControlRequest(
      await signedRequest({ path, nonce: "build-version-with-0002" }),
      env,
      {
        coordinator: new MemoryCoordinator(),
        backend: new MockBackend(),
        nowMs: TEST_NOW_MS,
      },
    );
    expect(((await withBinding.json()) as { features: string[] }).features).toContain(
      "trusted-build-v1",
    );
  });
});
