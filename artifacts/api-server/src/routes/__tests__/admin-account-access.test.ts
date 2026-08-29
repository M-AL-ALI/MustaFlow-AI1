import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  getById: vi.fn(),
  setBanned: vi.fn(),
  resolveStaff: vi.fn(),
  writeReceipt: vi.fn(),
}));

vi.mock("../../lib/clerk-users", () => ({
  findClerkAccountAccessByEmail: mocks.findByEmail,
  getClerkAccountAccessById: mocks.getById,
  setClerkAccountBanned: mocks.setBanned,
}));
vi.mock("../../lib/adminAuth", () => ({
  requireAdmin: ((req, _res, next) => {
    req.userId = "owner_actor";
    req.staffPrincipal = {
      userId: "owner_actor",
      role: "owner",
      source: "user_roles",
      grantedBy: null,
    };
    next();
  }) satisfies RequestHandler,
  requireOwner: ((_req, _res, next) => next()) satisfies RequestHandler,
  resolveStaffPrincipal: mocks.resolveStaff,
  writeAdminReceipt: mocks.writeReceipt,
}));
vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import adminAccountAccessRouter from "../admin-account-access";

const activeAccount = {
  userId: "user_target",
  email: "target@example.com",
  displayName: "Target User",
  imageUrl: null,
  banned: false,
  locked: false,
};

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(adminAccountAccessRouter);
  return instance;
}

describe("Owner account-access controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByEmail.mockResolvedValue(activeAccount);
    mocks.getById.mockResolvedValue(activeAccount);
    mocks.resolveStaff.mockResolvedValue(null);
    mocks.setBanned.mockImplementation(async (_userId: string, banned: boolean) => ({
      ...activeAccount,
      banned,
    }));
    mocks.writeReceipt.mockResolvedValue(undefined);
  });

  it("looks up one exact account without listing the Clerk estate", async () => {
    const response = await request(app()).get("/admin/accounts/lookup?email=Target%40Example.com");
    expect(response.status).toBe(200);
    expect(response.body.account).toMatchObject({
      userId: "user_target",
      email: "target@example.com",
      banned: false,
      staffRole: null,
    });
    expect(mocks.findByEmail).toHaveBeenCalledWith("target@example.com");
  });

  it("suspends access with a bounded reason and durable receipt", async () => {
    const response = await request(app())
      .post("/admin/accounts/user_target/suspend")
      .send({ reason: "Repeated policy violation" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, changed: true, account: { banned: true } });
    expect(mocks.setBanned).toHaveBeenCalledWith("user_target", true);
    expect(mocks.writeReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "owner_actor",
        action: "account_access_suspended",
        targetUserId: "user_target",
        reason: "Repeated policy violation",
        outcome: "completed",
      }),
    );
  });

  it("restores a suspended account through the same audited control", async () => {
    mocks.getById.mockResolvedValue({ ...activeAccount, banned: true });
    const response = await request(app())
      .post("/admin/accounts/user_target/restore")
      .send({ reason: "Policy review completed" });
    expect(response.status).toBe(200);
    expect(response.body.account.banned).toBe(false);
    expect(mocks.setBanned).toHaveBeenCalledWith("user_target", false);
  });

  it("cannot suspend self or any Owner account", async () => {
    const self = await request(app())
      .post("/admin/accounts/owner_actor/suspend")
      .send({ reason: "Should never be allowed" });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("admin_account_self_suspend_forbidden");

    mocks.resolveStaff.mockResolvedValue({ role: "owner" });
    const owner = await request(app())
      .post("/admin/accounts/user_target/suspend")
      .send({ reason: "Should never be allowed" });
    expect(owner.status).toBe(409);
    expect(owner.body.code).toBe("admin_account_owner_suspend_forbidden");
    expect(mocks.setBanned).not.toHaveBeenCalled();
  });

  it("rolls the identity change back when its receipt cannot be saved", async () => {
    mocks.writeReceipt.mockRejectedValue(new Error("receipt unavailable"));
    const response = await request(app())
      .post("/admin/accounts/user_target/suspend")
      .send({ reason: "Repeated policy violation" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("admin_account_access_audit_unavailable");
    expect(mocks.setBanned.mock.calls).toEqual([
      ["user_target", true],
      ["user_target", false],
    ]);
  });

  it("refuses invalid emails and unreceipted reasons before any provider mutation", async () => {
    const email = await request(app()).get("/admin/accounts/lookup?email=not-an-email");
    const reason = await request(app())
      .post("/admin/accounts/user_target/suspend")
      .send({ reason: "short" });
    expect(email.status).toBe(400);
    expect(email.body.code).toBe("admin_account_email_invalid");
    expect(reason.status).toBe(400);
    expect(reason.body.code).toBe("admin_account_reason_invalid");
    expect(mocks.findByEmail).not.toHaveBeenCalled();
    expect(mocks.setBanned).not.toHaveBeenCalled();
  });
});
