import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("./neon-project-lifecycle", () => ({
  lookupNeonProjectsByStableName: lookup,
  neonProjectNameFor: (id: number) => `mf-project-${id}`,
}));

import { ensureManualNeonAllocation, type ManualNeonProject } from "./manual-neon-allocation";

vi.mock("./neon-allocation-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./neon-allocation-intent")>()),
  resolveNeonAllocationOrganization: vi.fn(async () => ({ kind: "ready", organizationId: null })),
}));

import { resolveNeonAllocationOrganization } from "./neon-allocation-intent";

const uri = "postgresql://synthetic:fixture@ep-fixture.aws.neon.tech/neondb";

describe("manual Neon durable allocation protocol", () => {
  let project: ManualNeonProject;
  let recordIntent: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  let recordOwnership: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
  let assertActive: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    lookup.mockResolvedValue({ kind: "absent" });
    vi.mocked(resolveNeonAllocationOrganization).mockResolvedValue({
      kind: "ready",
      organizationId: null,
    });
    project = {
      id: 77,
      name: "Fixture",
      dbProvider: "none",
      dbStatus: "none",
      dbConnectionId: null,
      neonProjectId: null,
    };
    recordIntent = vi.fn(async () => {
      project.dbProvider = "postgres";
      project.dbStatus = "provisioning";
      return true;
    });
    recordOwnership = vi.fn(async (id: string) => {
      project.neonProjectId = id;
      project.dbConnectionId = id;
      return true;
    });
    assertActive = vi.fn(async () => true);
  });

  afterEach(() => vi.unstubAllGlobals());

  function run() {
    return ensureManualNeonAllocation({
      project: { ...project },
      apiKey: "synthetic-key",
      assertActive,
      store: { recordIntent, recordOwnership },
    });
  }

  it("uses the purge-recognized stable name and one bounded, non-redirecting POST", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      expect(recordIntent).toHaveBeenCalledOnce();
      expect(project.dbStatus).toBe("provisioning");
      expect(options).toMatchObject({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      expect(JSON.parse(options?.body as string).project.name).toBe("mf-project-77");
      return Response.json({
        project: { id: "neon-fixture" },
        connection_uris: [{ connection_uri: uri }],
      });
    });
    expect(await run()).toEqual({ neonProjectId: "neon-fixture", connectionString: uri });
    expect(fetch).toHaveBeenCalledOnce();
    expect(recordOwnership).toHaveBeenCalledWith("neon-fixture");
  });

  it.each(["error", "provisioning"])(
    "does not allocate again from unresolved %s even after an empty catalog",
    async (status) => {
      project.dbProvider = "postgres";
      project.dbStatus = status;
      expect(await run()).toBeNull();
      expect(recordIntent).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not retry a timed-out POST on a later invocation", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic-timeout"));
    expect(await run()).toBeNull();
    expect(await run()).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(recordIntent).toHaveBeenCalledOnce();
  });

  it("never POSTs after an uncertain intent commit acknowledgement", async () => {
    recordIntent.mockImplementationOnce(async () => {
      project.dbProvider = "postgres";
      project.dbStatus = "provisioning";
      throw new Error("synthetic-acknowledgement-lost");
    });
    expect(await run()).toBeNull();
    expect(await run()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records valid ownership even when the connection metadata is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ project: { id: "neon-fixture" } }));
    expect(await run()).toBeNull();
    expect(recordOwnership).toHaveBeenCalledWith("neon-fixture");
    expect(project.neonProjectId).toBe("neon-fixture");
  });

  it("retains intent without inventing success when ownership persistence fails", async () => {
    recordOwnership.mockRejectedValueOnce(new Error("synthetic-write-failure"));
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        project: { id: "neon-fixture" },
        connection_uris: [{ connection_uri: uri }],
      }),
    );
    expect(await run()).toBeNull();
    expect(project.dbStatus).toBe("provisioning");
    expect(await run()).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([{ kind: "unavailable" }, { kind: "found", projectIds: ["neon-one", "neon-two"] }])(
    "refuses an unavailable or ambiguous provider catalog",
    async (result) => {
      lookup.mockResolvedValue(result);
      expect(await run()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(recordIntent).not.toHaveBeenCalled();
    },
  );

  it("rejects conflicting stored ownership without provider calls", async () => {
    project.neonProjectId = "neon-one";
    project.dbConnectionId = "neon-two";
    expect(await run()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not adopt a provider resource belonging to another project", async () => {
    lookup.mockResolvedValue({ kind: "found", projectIds: ["neon-fixture"] });
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ project: { id: "neon-fixture", name: "mf-project-51" } }),
    );
    expect(await run()).toBeNull();
    expect(recordOwnership).not.toHaveBeenCalled();
    expect(recordIntent).not.toHaveBeenCalled();
  });

  it("carries organization context into POST before spending the durable attempt", async () => {
    vi.mocked(resolveNeonAllocationOrganization).mockResolvedValue({
      kind: "ready",
      organizationId: "org-fixture",
    });
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        project: { id: "neon-fixture" },
        connection_uris: [{ connection_uri: uri }],
      }),
    );
    expect(await run()).not.toBeNull();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string).project.org_id).toBe(
      "org-fixture",
    );
  });

  it("does not persist an intent or POST with unavailable organization context", async () => {
    vi.mocked(resolveNeonAllocationOrganization).mockResolvedValue({ kind: "unavailable" });
    expect(await run()).toBeNull();
    expect(recordIntent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds provider response bytes before JSON parsing and retains the allocation intent", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(" ".repeat(256 * 1024 + 1)));
    expect(await run()).toBeNull();
    expect(project.dbStatus).toBe("provisioning");
    expect(recordOwnership).not.toHaveBeenCalled();
  });

  it("does not cross the provider boundary after lifecycle authority is lost", async () => {
    assertActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await run()).toBeNull();
    expect(recordIntent).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(project.dbStatus).toBe("provisioning");
  });
});
