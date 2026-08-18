import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  checkV1ProjectAccess: vi.fn(async () => false),
  projectRoleForV1Scopes: vi.fn(() => "viewer"),
}));

vi.mock("../access", () => ({
  checkV1ProjectAccess: mocks.checkV1ProjectAccess,
  isPatAuth: vi.fn(() => false),
  projectRoleForV1Scopes: mocks.projectRoleForV1Scopes,
}));
vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(() => ({ userId: "requesting-user", sessionClaims: {} })),
}));
vi.mock("../../../lib/pat-auth", () => ({
  patAuthMiddleware: vi.fn(),
  generateRawToken: vi.fn(),
  hashToken: vi.fn(),
}));
vi.mock("../../../lib/event-bus", () => ({ publishDomainEvent: vi.fn() }));
vi.mock("../../../lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../projects", () => ({ default: vi.fn((_req, _res, next) => next()) }));
vi.mock("../builds", () => ({ default: vi.fn((_req, _res, next) => next()) }));
vi.mock("../files", () => ({ default: vi.fn((_req, _res, next) => next()) }));
vi.mock("../webhooks", () => ({ default: vi.fn((_req, _res, next) => next()) }));

async function app() {
  const router = (await import("../index")).default;
  const instance = express();
  instance.use(express.json());
  instance.use(router);
  return instance;
}

describe("authorization lockdown: v1 index project targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkV1ProjectAccess.mockResolvedValue(false);
    mocks.projectRoleForV1Scopes.mockReturnValue("viewer");
  });

  it.each([
    ["get", "/projects/1201/domains", undefined, undefined],
    ["post", "/projects/1202/domains", { hostname: "test.example" }, "admin"],
    ["delete", "/projects/1203/domains/41", undefined, "admin"],
    ["post", "/projects/1204/domains/42/verify", {}, "admin"],
  ] as const)("denies %s %s before domain access", async (method, path, body, role) => {
    const client = request(await app());
    const response = await client[method](path).send(body);

    expect(response.status).toBe(404);
    const projectId = Number(path.split("/")[2]);
    if (role) {
      expect(mocks.checkV1ProjectAccess).toHaveBeenCalledWith(expect.anything(), projectId, role);
    } else {
      expect(mocks.checkV1ProjectAccess).toHaveBeenCalledWith(expect.anything(), projectId);
    }
  });

  it("denies POST /tokens for another user's project with a non-enumerating response", async () => {
    const response = await request(await app())
      .post("/tokens")
      .send({
        name: "Project automation",
        projectId: 1205,
        scopes: ["projects:read"],
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found." });
    expect(mocks.projectRoleForV1Scopes).toHaveBeenCalledWith(["projects:read"]);
    expect(mocks.checkV1ProjectAccess).toHaveBeenCalledWith(expect.anything(), 1205, "viewer");
  });
});
