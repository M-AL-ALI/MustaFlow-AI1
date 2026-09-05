import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ organization: vi.fn() }));
vi.mock("./neon-allocation-intent", () => ({
  resolveNeonAllocationOrganization: mocks.organization,
}));

import {
  ensurePreviewDatabaseAllocation,
  hasUnresolvedPreviewDatabaseAllocation,
  previewDatabaseEvidenceMatches,
  previewDatabaseStateDigest,
  reconcilePreviewDatabaseAllocation,
  releasePreviewDatabaseAllocation,
  type PreviewDatabaseAllocationReceipt,
  type PreviewDatabaseState,
} from "./preview-database-allocation";

const projectId = 51;
const project = {
  id: "neon-preview-51",
  name: "mf-preview-51",
  org_id: "org-fixture",
  region_id: "aws-us-east-1",
  default_branch_id: "br-preview",
};
const uri = "postgresql://mustaflow:fixture@ep-preview.neon.tech/preview";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function receipt(
  overrides: Partial<PreviewDatabaseAllocationReceipt> = {},
): PreviewDatabaseAllocationReceipt {
  return {
    version: 1,
    projectId,
    allocationId: "00000000-0000-4000-8000-000000000051",
    organizationId: "org-fixture",
    regionId: "aws-us-east-1",
    provenance: "single-dispatch",
    providerProjectId: null,
    ...overrides,
  };
}
function durable(
  state: PreviewDatabaseState = { status: "none", hasCredential: false, allocation: null },
) {
  const recordReceipt = vi.fn(
    async (
      expected: PreviewDatabaseAllocationReceipt | null,
      next: PreviewDatabaseAllocationReceipt,
    ) => {
      if (JSON.stringify(state.allocation) !== JSON.stringify(expected)) return false;
      state.allocation = { ...next };
      state.status = "provisioning";
      return true;
    },
  );
  return { state, recordReceipt };
}
function provider(
  handler: (url: URL, method: string, init?: RequestInit) => Promise<Response> | Response,
) {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(new URL(String(input)), init?.method ?? "GET", init),
  );
}
function input(store: ReturnType<typeof durable>, fetcher: ReturnType<typeof provider>) {
  return { projectId, name: "Fixture", ...store, fetch: fetcher as typeof fetch };
}
function pending() {
  return durable({ status: "error", hasCredential: false, allocation: receipt() });
}
function known() {
  return durable({
    status: "ready",
    hasCredential: true,
    allocation: receipt({ providerProjectId: project.id }),
  });
}
function readOnly(fetcher: ReturnType<typeof provider>) {
  expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
}

describe("durable preview allocation boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NEON_API_KEY", "fixture-key");
    mocks.organization
      .mockReset()
      .mockResolvedValue({ kind: "ready", organizationId: "org-fixture" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("retains a delayed POST claim across empty-catalog retries and purge attempts", async () => {
    const store = durable();
    let finish!: (response: Response) => void;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = provider(async (_url, method) => {
      if (method === "POST") {
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return json({ projects: [] });
    });
    const first = ensurePreviewDatabaseAllocation(input(store, fetcher));
    await dispatched;
    expect(store.state.allocation).toMatchObject({
      provenance: "single-dispatch",
      providerProjectId: null,
    });
    await expect(ensurePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
    await expect(reconcilePreviewDatabaseAllocation(input(store, fetcher))).resolves.toEqual(
      store.state.allocation,
    );
    await expect(releasePreviewDatabaseAllocation(input(store, fetcher))).rejects.toThrow(
      "project_purge_preview_allocation_unresolved",
    );
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    finish(json({ project, connection_uris: [{ connection_uri: uri }] }, 201));
    await expect(first).resolves.toMatchObject({ connectionString: uri });
  });

  it.each(["false", "lost-acknowledgement"])(
    "never POSTs after a failed durable claim: %s",
    async (failure) => {
      const store = durable();
      const save = store.recordReceipt;
      const recordReceipt = vi.fn(
        async (
          expected: PreviewDatabaseAllocationReceipt | null,
          next: PreviewDatabaseAllocationReceipt,
        ) => {
          if (failure === "false") return false;
          await save(expected, next);
          throw new Error("commit acknowledgement lost");
        },
      );
      const fetcher = provider(() => json({ projects: [] }));
      await expect(
        ensurePreviewDatabaseAllocation({
          ...input(store, fetcher),
          recordReceipt,
        }),
      ).resolves.toBeNull();
      readOnly(fetcher);
      if (failure !== "false") {
        await expect(ensurePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
        expect(hasUnresolvedPreviewDatabaseAllocation(projectId, store.state)).toBe(true);
        readOnly(fetcher);
      }
    },
  );

  it("persists provider ownership before a missing credential and only GETs on recovery", async () => {
    const store = durable();
    const fetcher = provider((url, method) => {
      if (method === "POST") return json({ project }, 201);
      if (url.pathname.endsWith("/projects")) return json({ projects: [] });
      throw new Error("unexpected request");
    });
    await expect(ensurePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
    expect(store.state.allocation).toMatchObject({ providerProjectId: project.id });
    expect(store.recordReceipt).toHaveBeenCalledTimes(2);
    const retry = provider((url) => {
      if (url.pathname.endsWith("/projects")) return json({ projects: [project] });
      if (url.pathname.endsWith("/databases")) return json({ databases: [{ name: "preview" }] });
      if (url.pathname.endsWith("/roles")) return json({ roles: [{ name: "mustaflow" }] });
      if (url.pathname.endsWith("/connection_uri")) return json({ uri });
      return json({ project });
    });
    await expect(ensurePreviewDatabaseAllocation(input(store, retry))).resolves.toMatchObject({
      connectionString: uri,
    });
    readOnly(retry);
  });

  it("keeps the unknown-provider claim when ownership CAS fails after POST", async () => {
    const store = durable();
    const save = store.recordReceipt;
    const recordReceipt = vi.fn(
      async (
        expected: PreviewDatabaseAllocationReceipt | null,
        next: PreviewDatabaseAllocationReceipt,
      ) => (next.providerProjectId === null ? save(expected, next) : false),
    );
    const fetcher = provider((_url, method) =>
      method === "POST"
        ? json({ project, connection_uris: [{ connection_uri: uri }] }, 201)
        : json({ projects: [] }),
    );
    await expect(
      ensurePreviewDatabaseAllocation({
        ...input(store, fetcher),
        recordReceipt,
      }),
    ).resolves.toBeNull();
    expect(store.state.allocation).toMatchObject({ providerProjectId: null });
    expect(hasUnresolvedPreviewDatabaseAllocation(projectId, store.state)).toBe(true);
  });

  it.each(["provisioning", "error", "ready"])(
    "never settles a legacy %s row from an empty catalog",
    async (status) => {
      const store = durable({ status, hasCredential: status === "ready", allocation: null });
      const fetcher = provider(() => json({ projects: [] }));
      await expect(ensurePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
      await expect(reconcilePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
      await expect(releasePreviewDatabaseAllocation(input(store, fetcher))).rejects.toThrow(
        "project_purge_preview_allocation_unresolved",
      );
      expect(store.recordReceipt).not.toHaveBeenCalled();
      readOnly(fetcher);
    },
  );

  it("records a visible legacy owner without asserting that no other old POST is pending", async () => {
    const store = durable({ status: "error", hasCredential: false, allocation: null });
    const fetcher = provider((url) =>
      url.pathname.endsWith("/projects") ? json({ projects: [project] }) : json({ project }),
    );
    await expect(reconcilePreviewDatabaseAllocation(input(store, fetcher))).resolves.toMatchObject({
      provenance: "legacy-unknown",
      providerProjectId: project.id,
    });
    expect(hasUnresolvedPreviewDatabaseAllocation(projectId, store.state)).toBe(true);
    await expect(releasePreviewDatabaseAllocation(input(store, fetcher))).rejects.toThrow(
      "project_purge_preview_allocation_unresolved",
    );
    readOnly(fetcher);
  });

  it.each([
    { projects: [], unavailable: ["hidden"] },
    { projects: [], unavailable_project_ids: ["hidden"] },
    { projects: [project, { ...project, id: "second-owner" }] },
    { projects: [], pagination: { cursor: "" } },
    { projects: [{ ...project, org_id: "other-org" }] },
  ])("does not collapse incomplete or ambiguous catalog evidence to absent", async (catalog) => {
    const store = durable();
    const fetcher = provider(() => json(catalog));
    await expect(ensurePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
    expect(store.recordReceipt).not.toHaveBeenCalled();
    readOnly(fetcher);
  });

  it("requires the recorded organization and exact region before adopting an owner", async () => {
    const store = pending();
    const fetcher = provider((url) =>
      url.pathname.endsWith("/projects")
        ? json({ projects: [project] })
        : json({ project: { ...project, region_id: "aws-eu-west-1" } }),
    );
    await expect(reconcilePreviewDatabaseAllocation(input(store, fetcher))).rejects.toThrow();
    expect(store.recordReceipt).not.toHaveBeenCalled();
    mocks.organization.mockResolvedValue({ kind: "ready", organizationId: "other-org" });
    fetcher.mockClear();
    await expect(ensurePreviewDatabaseAllocation(input(store, fetcher))).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not dispatch after lifecycle loss immediately following a successful claim", async () => {
    const store = durable();
    let active = true;
    const save = store.recordReceipt;
    const fetcher = provider(() => json({ projects: [] }));
    await expect(
      ensurePreviewDatabaseAllocation({
        ...input(store, fetcher),
        assertActive: async () => active,
        recordReceipt: async (expected, next) => {
          const saved = await save(expected, next);
          active = false;
          return saved;
        },
      }),
    ).resolves.toBeNull();
    expect(hasUnresolvedPreviewDatabaseAllocation(projectId, store.state)).toBe(true);
    readOnly(fetcher);
  });

  it("requires GET 404 after DELETE and binds the proof to the exact receipt", async () => {
    const store = known();
    let deleted = false;
    const fetcher = provider((url, method) => {
      if (url.pathname.endsWith("/projects")) return json({ projects: [project] });
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return deleted ? new Response(null, { status: 404 }) : json({ project });
    });
    const proof = await releasePreviewDatabaseAllocation(input(store, fetcher));
    expect(proof.kind).toBe("provider-404");
    expect(previewDatabaseEvidenceMatches(projectId, store.state, proof)).toBe(true);
    expect(
      previewDatabaseEvidenceMatches(
        projectId,
        {
          ...store.state,
          allocation: receipt({ providerProjectId: "different-owner" }),
        },
        proof,
      ),
    ).toBe(false);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "GET",
      "DELETE",
      "GET",
    ]);
  });

  it("does not produce deletion evidence after lease loss during a provider request", async () => {
    const store = known();
    let active = true;
    const fetcher = provider((url) => {
      if (url.pathname.endsWith("/projects")) return json({ projects: [project] });
      active = false;
      return new Response(null, { status: 404 });
    });
    await expect(
      releasePreviewDatabaseAllocation({
        ...input(store, fetcher),
        assertActive: async () => active,
      }),
    ).rejects.toThrow();
    readOnly(fetcher);
  });

  it("rejects old boolean checkpoints and never accepts proof for unknown dispatched or legacy state", () => {
    const store = durable();
    expect(previewDatabaseEvidenceMatches(projectId, store.state, { databaseComplete: true })).toBe(
      false,
    );
    for (const state of [
      pending().state,
      {
        status: "error",
        hasCredential: false,
        allocation: receipt({ provenance: "legacy-unknown", providerProjectId: project.id }),
      },
    ]) {
      expect(
        previewDatabaseEvidenceMatches(projectId, state, {
          version: 1,
          kind: "provider-404",
          stateDigest: previewDatabaseStateDigest(projectId, state),
        }),
      ).toBe(false);
    }
  });
});
