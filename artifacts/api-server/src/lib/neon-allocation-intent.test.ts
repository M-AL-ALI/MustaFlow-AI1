import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("./neon-project-lifecycle", () => ({
  lookupNeonProjectsByStableName: lookup,
  neonProjectNameFor: (id: number) => `mf-project-${id}`,
}));
import {
  hasUnresolvedNeonAllocationIntent,
  mayStartNeonAllocation,
  reconcileNeonAllocationIntent,
  resolveNeonAllocationOrganization,
  type NeonAllocationIntentState,
} from "./neon-allocation-intent";

const untouched: NeonAllocationIntentState = {
  dbProvider: "none",
  dbStatus: "none",
  neonProjectId: null,
  dbConnectionId: null,
};
const unresolved: NeonAllocationIntentState = {
  ...untouched,
  dbProvider: "postgres",
  dbStatus: "error",
};

describe("shared Neon allocation intent fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEON_ORG_ID", "");
    vi.stubGlobal("fetch", vi.fn());
    lookup.mockResolvedValue({ kind: "absent" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("only admits a pristine allocation and retains every unowned postgres state", () => {
    expect(mayStartNeonAllocation(untouched)).toBe(true);
    expect(hasUnresolvedNeonAllocationIntent(untouched)).toBe(false);
    for (const dbStatus of ["none", "provisioning", "error", "connected"]) {
      const state = { ...unresolved, dbStatus };
      expect(mayStartNeonAllocation(state)).toBe(false);
      expect(hasUnresolvedNeonAllocationIntent(state)).toBe(true);
    }
    expect(mayStartNeonAllocation({ ...untouched, neonProjectId: "neon-existing" })).toBe(false);
  });

  it("accepts one durable identity but rejects malformed or conflicting pointers", () => {
    expect(
      hasUnresolvedNeonAllocationIntent({ ...unresolved, neonProjectId: "neon-existing" }),
    ).toBe(false);
    expect(hasUnresolvedNeonAllocationIntent({ ...unresolved, neonProjectId: "../bad" })).toBe(
      true,
    );
    expect(
      hasUnresolvedNeonAllocationIntent({
        ...unresolved,
        neonProjectId: "neon-one",
        dbConnectionId: "neon-two",
      }),
    ).toBe(true);
  });

  it.each([
    { kind: "absent" },
    { kind: "unavailable" },
    { kind: "found", projectIds: ["one", "two"] },
  ])("never clears uncertainty from a non-unique provider observation", async (result) => {
    lookup.mockResolvedValue(result);
    const recordOwnership = vi.fn();
    expect(
      await reconcileNeonAllocationIntent({ projectId: 77, state: unresolved, recordOwnership }),
    ).toBeNull();
    expect(recordOwnership).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows an owner retry to recover a delayed allocation only after ownership commits", async () => {
    const recordOwnership = vi.fn(async () => true);
    expect(
      await reconcileNeonAllocationIntent({ projectId: 77, state: unresolved, recordOwnership }),
    ).toBeNull();
    lookup.mockResolvedValue({ kind: "found", projectIds: ["neon-delayed"] });
    expect(
      await reconcileNeonAllocationIntent({ projectId: 77, state: unresolved, recordOwnership }),
    ).toBe("neon-delayed");
    expect(recordOwnership).toHaveBeenCalledWith("neon-delayed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, "throw"])(
    "does not resolve an uncommitted ownership receipt (%s)",
    async (failure) => {
      lookup.mockResolvedValue({ kind: "found", projectIds: ["neon-delayed"] });
      const recordOwnership = vi.fn(async () => {
        if (failure === "throw") throw new Error("lost-ack");
        return false;
      });
      expect(
        await reconcileNeonAllocationIntent({ projectId: 77, state: unresolved, recordOwnership }),
      ).toBeNull();
    },
  );

  it("does not overwrite conflicting ownership using a name lookup", async () => {
    expect(
      await reconcileNeonAllocationIntent({
        projectId: 77,
        state: { ...unresolved, neonProjectId: "neon-one", dbConnectionId: "neon-two" },
        recordOwnership: vi.fn(),
      }),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves explicit organization context without probing or caching the key", async () => {
    vi.stubEnv("NEON_ORG_ID", " org-fixture ");
    expect(await resolveNeonAllocationOrganization("synthetic-key")).toEqual({
      kind: "ready",
      organizationId: "org-fixture",
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("NEON_ORG_ID", "org-different");
    expect(await resolveNeonAllocationOrganization("synthetic-other-key")).toEqual({
      kind: "ready",
      organizationId: "org-different",
    });
  });

  it.each([
    { organizations: [], expected: null },
    { organizations: [{ id: "org-fixture" }], expected: "org-fixture" },
  ])("resolves an unambiguous personal-account context", async ({ organizations, expected }) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ organizations }));
    expect(await resolveNeonAllocationOrganization("synthetic-key")).toEqual({
      kind: "ready",
      organizationId: expected,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://console.neon.tech/api/v2/users/me/organizations",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([401, 403, 404, 429, 500])(
    "requires explicit context rather than guessing after organization HTTP %i",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(new Response("synthetic-sensitive-body", { status }));
      expect(await resolveNeonAllocationOrganization("synthetic-key")).toEqual({
        kind: "unavailable",
      });
    },
  );

  it.each([
    {},
    { organizations: [{ id: "org-one" }, { id: "org-two" }] },
    { organizations: [{ id: "../invalid" }] },
    { organizations: [], pagination: { cursor: "more" } },
  ])("rejects malformed or incomplete organization metadata", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    expect(await resolveNeonAllocationOrganization("synthetic-key")).toEqual({
      kind: "unavailable",
    });
  });

  it("bounds organization response bytes", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(" ".repeat(32_769)));
    expect(await resolveNeonAllocationOrganization("synthetic-key")).toEqual({
      kind: "unavailable",
    });
  });
});
