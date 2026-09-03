import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findByEmail = vi.hoisted(() => vi.fn());

vi.mock("./clerk-users", () => ({
  findClerkAccountAccessByEmail: findByEmail,
}));

import { resolveAdminRoleGrantEmail } from "./admin-role-email";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.post("/admin/roles", resolveAdminRoleGrantEmail, ((req, res) =>
    res.json({ email: req.body.email, userId: req.body.userId })) satisfies RequestHandler);
  return instance;
}

describe("Admin role email admission", () => {
  beforeEach(() => {
    findByEmail.mockReset();
    findByEmail.mockResolvedValue({ userId: "user_stable_target" });
  });

  it("normalizes exact email input and forwards only the resolved Clerk user ID", async () => {
    const response = await request(app())
      .post("/admin/roles")
      .send({ email: "  Staff.Member@Example.com  ", role: "support" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      email: "staff.member@example.com",
      userId: "user_stable_target",
    });
    expect(findByEmail).toHaveBeenCalledWith("staff.member@example.com");
  });

  it("rejects invalid email before consulting Clerk", async () => {
    const response = await request(app())
      .post("/admin/roles")
      .send({ email: "not-an-email", role: "support" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("admin_role_email_invalid");
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it("does not create a grant for an unknown account", async () => {
    findByEmail.mockResolvedValue(null);
    const response = await request(app())
      .post("/admin/roles")
      .send({ email: "missing@example.com", role: "support" });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("admin_role_account_not_found");
  });

  it("fails closed when Clerk identity verification is unavailable", async () => {
    findByEmail.mockRejectedValue(new Error("provider unavailable"));
    const response = await request(app())
      .post("/admin/roles")
      .send({ email: "staff@example.com", role: "support" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("admin_role_identity_unavailable");
  });
});
