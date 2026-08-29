import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const state = vi.hoisted(() => ({
  role: null as string | null,
  grantedBy: null as string | null,
  receipts: [] as Array<Record<string, unknown>>,
  failInsert: false,
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({ kind: "where" })) }));
vi.mock("@workspace/db", () => ({
  adminAccessReceiptsTable: {},
  userRolesTable: { userId: {}, role: {}, grantedBy: {} },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () =>
          state.role ? [{ role: state.role, grantedBy: state.grantedBy }] : [],
        ),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: Record<string, unknown>) => {
        if (state.failInsert) throw new Error("receipt store unavailable");
        state.receipts.push(value);
      }),
    })),
  },
}));
vi.mock("./logger", () => ({ logger: { error: vi.fn() } }));

import { requireAdmin, requireSupportResolver, staffRoleAllowsRequest } from "./adminAuth";
import { decideStaffRemoval, decideStaffRoleChange } from "./admin-role-policy";

function response() {
  const result = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, result };
}

function request(path: string, method = "GET", userId = "user_test"): Request {
  return {
    userId,
    originalUrl: path,
    path,
    method,
    params: {},
    query: {},
    body: {},
  } as unknown as Request;
}

describe("Admin Page access foundation", () => {
  beforeEach(() => {
    state.role = null;
    state.grantedBy = null;
    state.receipts.length = 0;
    state.failInsert = false;
  });

  it("makes a nonallowlisted route indistinguishable from an unknown route", async () => {
    const { res, result } = response();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdmin(request("/api/admin/me"), res, next);
    expect(result).toEqual({ statusCode: 404, body: { error: "Not found" } });
    expect(next).not.toHaveBeenCalled();
    expect(state.receipts).toEqual([
      expect.objectContaining({
        actorUserId: "user_test",
        actorRole: "none",
        kind: "refusal",
        outcome: "not_allowlisted",
      }),
    ]);
  });

  it("records who, what, when-target context before an authorized view proceeds", async () => {
    state.role = "owner";
    const req = request("/api/admin/billing/users?workspaceId=42");
    req.query = { workspaceId: "42" };
    const { res, result } = response();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdmin(req, res, next);
    expect(result.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
    expect(req.staffPrincipal?.role).toBe("owner");
    expect(req.staffPrincipal?.source).toBe("user_roles");
    expect(state.receipts).toEqual([
      expect.objectContaining({
        actorUserId: "user_test",
        actorRole: "owner",
        kind: "access",
        action: "GET /api/admin/billing/users",
        targetWorkspaceId: 42,
        outcome: "authorized",
      }),
    ]);
  });

  it("fails closed when an authorized access cannot be receipted", async () => {
    state.role = "operator";
    state.failInsert = true;
    const { res, result } = response();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdmin(request("/api/admin/stats"), res, next);
    expect(result).toEqual({
      statusCode: 503,
      body: {
        error: "Admin access could not be audited. Please try again.",
        code: "admin_audit_unavailable",
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns a typed least-privilege refusal and receipts it", async () => {
    state.role = "operator";
    const { res, result } = response();
    const next = vi.fn() as unknown as NextFunction;
    await requireAdmin(request("/api/admin/roles", "POST"), res, next);
    expect(result).toEqual({
      statusCode: 403,
      body: {
        error: "Your staff role does not allow this action.",
        code: "admin_role_forbidden",
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(state.receipts).toEqual([
      expect.objectContaining({
        actorRole: "operator",
        kind: "refusal",
        outcome: "role_lacks_action",
      }),
    ]);
  });

  it("keeps the four roles least-privileged by a closed central policy", () => {
    expect(staffRoleAllowsRequest("owner", "POST", "/api/admin/roles")).toBe(true);
    expect(staffRoleAllowsRequest("owner", "POST", "/api/admin/accounts/user_2/suspend")).toBe(
      true,
    );
    expect(staffRoleAllowsRequest("operator", "POST", "/api/admin/roles")).toBe(false);
    expect(staffRoleAllowsRequest("operator", "POST", "/api/admin/accounts/user_2/suspend")).toBe(
      false,
    );
    expect(staffRoleAllowsRequest("operator", "POST", "/api/admin/domains/7/suspend")).toBe(true);
    expect(staffRoleAllowsRequest("support", "POST", "/api/admin/support-tickets/7/reply")).toBe(
      true,
    );
    expect(staffRoleAllowsRequest("support", "POST", "/api/admin/support-defects/7/verify")).toBe(
      true,
    );
    expect(staffRoleAllowsRequest("support", "GET", "/api/admin/support-assignees")).toBe(true);
    expect(staffRoleAllowsRequest("support", "GET", "/api/admin/stats")).toBe(false);
    expect(staffRoleAllowsRequest("analyst", "GET", "/api/admin/stats")).toBe(true);
    expect(staffRoleAllowsRequest("analyst", "GET", "/api/admin/records/projects")).toBe(true);
    expect(staffRoleAllowsRequest("support", "GET", "/api/admin/records/projects")).toBe(false);
    expect(staffRoleAllowsRequest("analyst", "GET", "/api/admin/support-assignees")).toBe(false);
    expect(staffRoleAllowsRequest("analyst", "POST", "/api/admin/domains/7/suspend")).toBe(false);
  });

  it("requires a named operational role for an evidence-bearing resolution", async () => {
    const analystReq = request("/api/admin/support-tickets/7/verify", "POST");
    analystReq.staffPrincipal = {
      userId: "analyst_test",
      role: "analyst",
      source: "user_roles",
      grantedBy: "owner_test",
    };
    const analystResponse = response();
    const analystNext = vi.fn() as unknown as NextFunction;
    await requireSupportResolver(analystReq, analystResponse.res, analystNext);
    expect(analystResponse.result).toEqual({
      statusCode: 403,
      body: {
        error: "Your staff role cannot approve a support resolution.",
        code: "support_resolver_required",
      },
    });
    expect(analystNext).not.toHaveBeenCalled();

    const supportReq = request("/api/admin/support-tickets/7/verify", "POST");
    supportReq.staffPrincipal = {
      userId: "support_test",
      role: "support",
      source: "user_roles",
      grantedBy: "owner_test",
    };
    const supportNext = vi.fn() as unknown as NextFunction;
    await requireSupportResolver(supportReq, response().res, supportNext);
    expect(supportNext).toHaveBeenCalledOnce();
  });

  it("makes the last Owner structurally non-removable and non-demotable", () => {
    expect(decideStaffRemoval("owner", 1)).toEqual({
      allowed: false,
      code: "admin_last_owner_required",
      message: "The last Owner cannot be removed. Add another Owner first.",
    });
    expect(decideStaffRoleChange("owner", "operator", 1)).toEqual({
      allowed: false,
      code: "admin_last_owner_required",
      message: "The last Owner cannot be changed. Add another Owner first.",
    });
    expect(decideStaffRemoval("owner", 2)).toEqual({ allowed: true });
    expect(decideStaffRoleChange("operator", "support", 1)).toEqual({ allowed: true });
  });
});
