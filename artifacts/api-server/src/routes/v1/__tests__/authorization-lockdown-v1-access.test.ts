import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkProjectAccess: vi.fn() }));

vi.mock("../../../lib/auth", () => ({ checkProjectAccess: mocks.checkProjectAccess }));

describe("authorization lockdown: v1 project access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rechecks a project-scoped PAT owner's live access on every call", async () => {
    mocks.checkProjectAccess.mockResolvedValueOnce("granted").mockResolvedValueOnce("not_member");
    const { checkV1ProjectAccess } = await import("../access");
    const req = {
      userId: "pat-owner",
      patProjectId: 1101,
      patScopes: ["projects:read"],
      headers: { authorization: "Bearer token" },
    } as unknown as Request;

    await expect(checkV1ProjectAccess(req, 1101)).resolves.toBe(true);
    await expect(checkV1ProjectAccess(req, 1101)).resolves.toBe(false);
    expect(mocks.checkProjectAccess).toHaveBeenNthCalledWith(1, "pat-owner", 1101, "viewer");
    expect(mocks.checkProjectAccess).toHaveBeenNthCalledWith(2, "pat-owner", 1101, "viewer");
  });

  it("denies a PAT whose project scope does not match before consulting access", async () => {
    const { checkV1ProjectAccess } = await import("../access");
    const req = {
      userId: "pat-owner",
      patProjectId: 1101,
      headers: { authorization: "Bearer token" },
    } as unknown as Request;

    await expect(checkV1ProjectAccess(req, 1102)).resolves.toBe(false);
    expect(mocks.checkProjectAccess).not.toHaveBeenCalled();
  });

  it("preserves live organization collaboration at the requested role", async () => {
    mocks.checkProjectAccess.mockResolvedValue("granted");
    const { checkV1ProjectAccess } = await import("../access");
    const req = {
      userId: "organization-collaborator",
      patProjectId: undefined,
      patScopes: [],
      headers: {},
    } as unknown as Request;

    await expect(checkV1ProjectAccess(req, 1102, "admin")).resolves.toBe(true);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith(
      "organization-collaborator",
      1102,
      "admin",
    );
  });

  it.each([
    [["projects:read"], "viewer"],
    [["files:write"], "member"],
    [["builds:trigger"], "member"],
    [["domains:write"], "admin"],
    [["webhooks:write"], "admin"],
  ] as const)("maps PAT scopes %j to the %s project role", async (scopes, expectedRole) => {
    const { projectRoleForV1Scopes } = await import("../access");
    expect(projectRoleForV1Scopes(scopes)).toBe(expectedRole);
  });
});
