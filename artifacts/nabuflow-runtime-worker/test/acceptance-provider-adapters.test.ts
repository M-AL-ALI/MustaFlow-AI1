import { describe, expect, it, vi } from "vitest";
import {
  AcceptanceProviderError,
  NativeAcceptanceProviderAdapters,
} from "../src/acceptance-provider-adapters";
import type {
  AcceptanceProvisionerBindings,
  StoredAcceptanceLease,
} from "../src/acceptance-provisioner-model";

const TEST_KEY = `rk_${"test"}_${"T".repeat(32)}`;
const LIVE_KEY = `rk_${"live"}_${"L".repeat(32)}`;

function env(
  overrides: Partial<AcceptanceProvisionerBindings> = {},
): AcceptanceProvisionerBindings {
  return {
    ACCEPTANCE_NEON_MANAGEMENT_KEY: "neon-management-fixture-0000000001",
    ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY: TEST_KEY,
    ACCEPTANCE_FLY_ORG_TOKEN: "fly-org-fixture-00000000000000001",
    ACCEPTANCE_NEON_ORGANIZATION_ID: "neon-dedicated",
    ACCEPTANCE_STRIPE_SANDBOX_ID: "stripe-dedicated",
    ACCEPTANCE_FLY_ORGANIZATION_SLUG: "fly-disposable",
    ACCEPTANCE_FLY_IMAGE_REF: "registry.example/image@sha256:fixture",
    ...overrides,
  } as unknown as AcceptanceProvisionerBindings;
}

function lease(
  scope: StoredAcceptanceLease["scope"],
  resource: StoredAcceptanceLease["resource"] = null,
): StoredAcceptanceLease {
  return {
    schemaVersion: 1,
    leaseId: `nal_${"a".repeat(40)}`,
    identityHash: "b".repeat(64),
    ownerSubjectHash: "c".repeat(64),
    projectId: 42,
    scope,
    state: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: 10_000,
    costCeilingMinorUnits: 100,
    costAmountMinorUnits: 0,
    resource,
    material: null,
    capabilityRevision: null,
    terminalCode: null,
  };
}

describe("acceptance provider adapters", () => {
  it("rejects foreign and live targets before dispatch", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    for (const scopedLease of [
      lease({ provider: "neon", organizationId: "foreign" }),
      lease({ provider: "stripe", sandboxId: "foreign", mode: "test" }),
      lease({ provider: "fly", organizationSlug: "production", disposable: true }),
    ]) {
      await expect(adapter.create(scopedLease)).rejects.toBeInstanceOf(AcceptanceProviderError);
    }
    const liveAdapter = new NativeAcceptanceProviderAdapters(
      env({ ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY: LIVE_KEY }),
      { fetch },
    );
    await expect(
      liveAdapter.create(
        lease({ provider: "stripe", sandboxId: "stripe-dedicated", mode: "test" }),
      ),
    ).rejects.toMatchObject({ causeClass: "pre_dispatch", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed if Stripe returns a live-mode object", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id: "pi_fixture", livemode: true }, { status: 200 }),
    );
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    await expect(
      adapter.create(lease({ provider: "stripe", sandboxId: "stripe-dedicated", mode: "test" })),
    ).rejects.toMatchObject({ code: "acceptance_live_target_forbidden", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("adopts a Neon project created before an ambiguous response without a duplicate POST", async () => {
    const connectionUrl = "postgresql://fixture:fixture@project.neon.tech/neondb";
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({
          projects: [{ id: "project-fixture", name: `nabu-accept-${"f".repeat(24)}` }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ uri: connectionUrl }));
    const adapterLease = lease({ provider: "neon", organizationId: "neon-dedicated" });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(adapterLease.leaseId),
    );
    const expectedName = `nabu-accept-${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24)}`;
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(
        Response.json({ projects: [{ id: "project-fixture", name: expectedName }] }),
      )
      .mockResolvedValueOnce(Response.json({ uri: connectionUrl }));
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    await expect(adapter.create(adapterLease)).resolves.toMatchObject({
      resource: { provider: "neon", ids: ["project-fixture"] },
      material: { kind: "neon-connection-string", value: connectionUrl },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("adopts a lease-tagged Fly Machine without creating a second app or Machine", async () => {
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json([{ id: "machine-existing" }]));
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    await expect(
      adapter.create(
        lease({ provider: "fly", organizationSlug: "fly-disposable", disposable: true }),
      ),
    ).resolves.toMatchObject({
      resource: { provider: "fly", ids: [expect.any(String), "machine-existing"] },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("discovers and removes a Neon orphan whose provider locator was never persisted", async () => {
    const adapterLease = lease({ provider: "neon", organizationId: "neon-dedicated" });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(adapterLease.leaseId),
    );
    const expectedName = `nabu-accept-${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24)}`;
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ projects: [{ id: "project-orphan", name: expectedName }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    await expect(adapter.destroy(adapterLease)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0].method).toBe("GET");
    expect(fetch.mock.calls[1][0].method).toBe("DELETE");
  });

  it("writes the disposable database URL only to the lease-created Fly Machine config", async () => {
    const databaseUrl = `postgresql://${"user"}:${"pass"}@fixture.neon.tech/db`;
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockImplementationOnce(async (request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toContain("/v1/apps/nabu-accept-fixture/machines/machine-fixture");
        return Response.json({
          config: {
            image: "fixture",
            env: { NABUFLOW_ACCEPTANCE_LEASE: `nal_${"a".repeat(40)}` },
            metadata: { nabuflow_acceptance_lease: `nal_${"a".repeat(40)}` },
          },
        });
      })
      .mockImplementationOnce(async (request) => {
        expect(request.method).toBe("POST");
        const body = (await request.json()) as { config: { env: Record<string, string> } };
        expect(body.config.env.DATABASE_URL).toBe(databaseUrl);
        return Response.json({ ok: true });
      });
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    const flyLease = lease(
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      {
        provider: "fly",
        ids: ["nabu-accept-fixture", "machine-fixture"],
        createdByLease: true,
        configurationWritten: false,
      },
    );
    await expect(adapter.writeFlyDatabaseUrl(flyLease, databaseUrl)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires both the Fly Machine and its configuration to be absent", async () => {
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const adapter = new NativeAcceptanceProviderAdapters(env(), { fetch });
    await expect(
      adapter.verifyGone(
        lease(
          { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
          {
            provider: "fly",
            ids: ["nabu-accept-fixture", "machine-fixture"],
            createdByLease: true,
            configurationWritten: true,
          },
        ),
      ),
    ).resolves.toEqual({ resourcesGone: true, configurationGone: true, costAmountMinorUnits: 0 });
  });
});
