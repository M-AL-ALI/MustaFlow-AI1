import { describe, expect, it } from "vitest";
import { handleControlRequest } from "../src/worker";
import { MockBackend, MemoryCoordinator, TEST_NOW_MS, fakeEnv, signedRequest } from "./helpers";

describe("signed Pantry service-binding gateway", () => {
  it("forwards only an authenticated allowlisted route with the trusted principal", async () => {
    const env = fakeEnv();
    const captured: Array<{ url: string; principal: string | null }> = [];
    env.PANTRY_CATALOG = {
      async fetch(request: Request) {
        captured.push({
          url: request.url,
          principal: request.headers.get("x-nabuflow-pantry-principal"),
        });
        return new Response(
          JSON.stringify({ ok: true, service: "pantry-catalog", schemaVersion: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const coordinator = new MemoryCoordinator();
    const dependencies = {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
      requestId: "pantry-gateway-health",
    };
    const unsigned = new Request("https://runtime.example/_nabuflow/control/v1/pantry/health");
    expect((await handleControlRequest(unsigned, env, dependencies)).status).toBe(401);
    expect(captured).toHaveLength(0);

    const signed = await signedRequest({
      path: "/_nabuflow/control/v1/pantry/health",
      nonce: "pantry-gateway-health-0001",
    });
    const response = await handleControlRequest(signed, env, dependencies);
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(new URL(captured[0].url).pathname).toBe("/internal/v1/health");
    expect(captured[0].principal).toBe("catalog-admin");
  });

  it("applies control idempotency and translates typed Pantry failures", async () => {
    const env = fakeEnv();
    let calls = 0;
    env.PANTRY_CATALOG = {
      async fetch() {
        calls += 1;
        return new Response(
          JSON.stringify({
            ok: false,
            code: "catalog_conflict",
            message: "Pantry revision commit conflicts",
            retryable: false,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const coordinator = new MemoryCoordinator();
    const path = `/_nabuflow/control/v1/pantry/assemblies/passembly_${"a".repeat(64)}/commit`;
    const first = await signedRequest({
      path,
      method: "POST",
      body: { fixture: true },
      nonce: "pantry-gateway-conflict-0001",
      idempotencyKey: "pantry-gateway-conflict",
    });
    const response = await handleControlRequest(first, env, {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
      requestId: "pantry-gateway-conflict",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "catalog_conflict",
      retryable: false,
      requestId: "pantry-gateway-conflict",
    });
    expect(calls).toBe(1);

    const replay = await signedRequest({
      path,
      method: "POST",
      body: { fixture: true },
      nonce: "pantry-gateway-conflict-0002",
      idempotencyKey: "pantry-gateway-conflict",
    });
    const replayed = await handleControlRequest(replay, env, {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
      requestId: "pantry-gateway-conflict-replay",
    });
    expect(replayed.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("fails closed when the private service binding is missing or returns malformed bytes", async () => {
    const missing = fakeEnv();
    delete (missing as Partial<typeof missing>).PANTRY_CATALOG;
    const path = "/_nabuflow/control/v1/pantry/health";
    const missingResponse = await handleControlRequest(
      await signedRequest({ path, nonce: "pantry-gateway-missing-0001" }),
      missing,
      {
        coordinator: new MemoryCoordinator(),
        backend: new MockBackend(),
        nowMs: TEST_NOW_MS,
        requestId: "pantry-gateway-missing",
      },
    );
    expect(missingResponse.status).toBe(503);
    await expect(missingResponse.json()).resolves.toMatchObject({
      code: "pantry_infrastructure_unavailable",
    });

    const malformed = fakeEnv();
    malformed.PANTRY_CATALOG = {
      async fetch() {
        return new Response("not-json", { status: 200 });
      },
    } as unknown as Fetcher;
    const malformedResponse = await handleControlRequest(
      await signedRequest({ path, nonce: "pantry-gateway-malformed-0001" }),
      malformed,
      {
        coordinator: new MemoryCoordinator(),
        backend: new MockBackend(),
        nowMs: TEST_NOW_MS,
        requestId: "pantry-gateway-malformed",
      },
    );
    expect(malformedResponse.status).toBe(503);
    await expect(malformedResponse.json()).resolves.toMatchObject({
      code: "pantry_infrastructure_unavailable",
    });
  });

  it("exposes assembly progress only through a signed read proxy", async () => {
    const env = fakeEnv();
    const assemblyId = `passembly_${"b".repeat(64)}`;
    let calls = 0;
    env.PANTRY_CATALOG = {
      async fetch(request: Request) {
        calls += 1;
        expect(new URL(request.url).pathname).toBe(`/internal/v1/assemblies/${assemblyId}`);
        expect(request.headers.get("x-nabuflow-pantry-principal")).toBe("builder-readonly");
        return Response.json({
          ok: true,
          assemblyId,
          ingest: { state: "running", attempt: 1 },
          stagedObjects: 3,
        });
      },
    } as unknown as Fetcher;
    const path = `/_nabuflow/control/v1/pantry/assemblies/${assemblyId}`;
    expect(
      (
        await handleControlRequest(new Request(`https://runtime.example${path}`), env, {
          coordinator: new MemoryCoordinator(),
          backend: new MockBackend(),
          nowMs: TEST_NOW_MS,
          requestId: "pantry-progress-unsigned",
        })
      ).status,
    ).toBe(401);
    const response = await handleControlRequest(
      await signedRequest({ path, nonce: "pantry-progress-signed-0001" }),
      env,
      {
        coordinator: new MemoryCoordinator(),
        backend: new MockBackend(),
        nowMs: TEST_NOW_MS,
        requestId: "pantry-progress-signed",
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });
});
