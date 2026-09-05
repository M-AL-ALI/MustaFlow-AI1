import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));

import {
  deleteNeonProjectAndProveAbsent,
  lookupNeonProjectsByStableName,
  releaseNeonProjectsForHardDelete,
} from "./neon-project-lifecycle";

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("strict Neon project lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEON_API_KEY = "test-neon-key";
  });

  afterEach(() => {
    delete process.env.NEON_API_KEY;
    vi.unstubAllGlobals();
  });

  it("performs a bounded exact-name lookup and ignores near matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, {
        projects: [
          { id: "preview-near", name: "mf-preview-510" },
          { id: "preview-exact", name: "mf-preview-51" },
        ],
        pagination: {},
        unavailable: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupNeonProjectsByStableName("mf-preview-51")).resolves.toEqual({
      kind: "found",
      projectIds: ["preview-exact"],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("search=mf-preview-51");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("limit=100");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("timeout=5000");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed on missing configuration or an unknown lookup response", async () => {
    delete process.env.NEON_API_KEY;
    await expect(lookupNeonProjectsByStableName("mf-preview-51")).resolves.toEqual({
      kind: "unavailable",
    });

    process.env.NEON_API_KEY = "test-neon-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, { projects: "wrong" })));
    await expect(lookupNeonProjectsByStableName("mf-preview-51")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("accepts omitted pagination only for a terminal short page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, {
        applications: [],
        integrations: [],
        projects: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupNeonProjectsByStableName("mf-project-51")).resolves.toEqual({
      kind: "absent",
    });

    fetchMock.mockResolvedValue(
      response(200, {
        projects: Array.from({ length: 100 }, (_, index) => ({
          id: `near-${index}`,
          name: `mf-project-${1000 + index}`,
        })),
      }),
    );
    await expect(lookupNeonProjectsByStableName("mf-project-51")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("deletes an existing project and requires a final GET 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteNeonProjectAndProveAbsent("neon-primary-51")).resolves.toBe(true);
    expect(
      fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method),
    ).toEqual([undefined, "DELETE", undefined]);
  });

  it("is idempotent when the provider already returns GET 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteNeonProjectAndProveAbsent("neon-primary-51")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses every lookup and delete after the caller loses its lease", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new Error("project_purge_lease_lost"));

    await expect(
      releaseNeonProjectsForHardDelete({
        projectIds: ["neon-primary-51"],
        productionProjectName: "mf-project-51",
        previewProjectName: "mf-preview-51",
        signal: controller.signal,
      }),
    ).rejects.toThrow("project_purge_lease_lost");
    await expect(
      deleteNeonProjectAndProveAbsent("neon-primary-51", controller.signal),
    ).rejects.toThrow("project_purge_lease_lost");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept DELETE without a final absence proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(200))
        .mockResolvedValueOnce(response(204))
        .mockResolvedValueOnce(response(200)),
    );
    await expect(deleteNeonProjectAndProveAbsent("neon-primary-51")).resolves.toBe(false);
  });

  it("recovers missing production and preview pointers by exact stable name before deletion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          projects: [{ id: "neon-production-51", name: "mf-project-51" }],
          pagination: {},
          unavailable: [],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          projects: [{ id: "neon-preview-51", name: "mf-preview-51" }],
          pagination: {},
          unavailable: [],
        }),
      )
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      releaseNeonProjectsForHardDelete({
        projectIds: ["neon-primary-51"],
        productionProjectName: "mf-project-51",
        previewProjectName: "mf-preview-51",
      }),
    ).resolves.toEqual({ removed: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("search=mf-project-51");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("search=mf-preview-51");
  });

  it("follows bounded cursor pagination and refuses incomplete or cyclic listings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          projects: [{ id: "near-1", name: "mf-project-510" }],
          pagination: { cursor: "page-2" },
          unavailable: [],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          projects: [{ id: "exact-51", name: "mf-project-51" }],
          pagination: {},
          unavailable: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupNeonProjectsByStableName("mf-project-51")).resolves.toEqual({
      kind: "found",
      projectIds: ["exact-51"],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toContain("cursor=page-2");

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      response(200, {
        projects: [{ id: "near-1", name: "mf-project-510" }],
        pagination: { cursor: "same-page" },
        unavailable: [],
      }),
    );
    await expect(lookupNeonProjectsByStableName("mf-project-51")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("fails closed when Neon reports an incomplete timed-out listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(200, {
          projects: [],
          pagination: {},
          unavailable: ["project-hidden-by-timeout"],
        }),
      ),
    );

    await expect(lookupNeonProjectsByStableName("mf-project-51")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("refuses unsafe identifiers, missing config, and provider uncertainty", async () => {
    await expect(
      releaseNeonProjectsForHardDelete({
        projectIds: ["bad/id"],
        productionProjectName: "mf-project-51",
        previewProjectName: "mf-preview-51",
      }),
    ).rejects.toThrow("project_purge_database_release_failed");

    delete process.env.NEON_API_KEY;
    await expect(
      releaseNeonProjectsForHardDelete({
        projectIds: [],
        productionProjectName: "mf-project-51",
        previewProjectName: "mf-preview-51",
      }),
    ).rejects.toThrow("project_purge_database_release_failed");
  });

  it("never logs raw provider response bodies", async () => {
    const rawProviderBody = "secret-provider-body";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ...response(500), text: () => rawProviderBody }),
    );

    await expect(deleteNeonProjectAndProveAbsent("neon-primary-51")).resolves.toBe(false);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(rawProviderBody);
  });
});
