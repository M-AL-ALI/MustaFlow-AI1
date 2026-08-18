import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  checkV1ProjectAccess: vi.fn(async () => false),
}));

vi.mock("../access", () => ({
  checkV1ProjectAccess: mocks.checkV1ProjectAccess,
  requirePatScope: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  isPatAuth: vi.fn(() => false),
}));
vi.mock("../../../lib/jobs", () => ({ enqueueJob: vi.fn(), cancelActiveJob: vi.fn() }));
vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

async function app() {
  const [{ default: projects }, { default: builds }, { default: files }, { default: webhooks }] =
    await Promise.all([
      import("../projects"),
      import("../builds"),
      import("../files"),
      import("../webhooks"),
    ]);
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.userId = "requesting-user";
    next();
  });
  instance.use(projects, builds, files, webhooks);
  return instance;
}

const cases = [
  ["get", "/projects/1301", undefined, undefined],
  ["get", "/projects/1302/builds", undefined, undefined],
  ["get", "/projects/1303/builds/51", undefined, undefined],
  ["post", "/projects/1304/builds", { prompt: "Build" }, "member"],
  ["post", "/projects/1305/builds/52/cancel", {}, "member"],
  ["get", "/projects/1306/files", undefined, undefined],
  ["get", "/projects/1307/files/src/index.ts", undefined, undefined],
  ["put", "/projects/1308/files/src/index.ts", { content: "export {};" }, "member"],
  ["get", "/projects/1309/webhooks", undefined, undefined],
  ["post", "/projects/1310/webhooks", { url: "https://example.test/hook" }, "admin"],
  ["delete", "/projects/1311/webhooks/53", undefined, "admin"],
] as const;

describe("authorization lockdown: v1 routes reject hostile project ids", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkV1ProjectAccess.mockResolvedValue(false);
  });

  it.each(cases)("denies %s %s before touching project data", async (method, path, body, role) => {
    const client = request(await app());
    const response = await client[method](path).send(body);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found." });
    const projectId = Number(path.split("/")[2]);
    if (role) {
      expect(mocks.checkV1ProjectAccess).toHaveBeenCalledWith(expect.anything(), projectId, role);
    } else {
      expect(mocks.checkV1ProjectAccess).toHaveBeenCalledWith(expect.anything(), projectId);
    }
  });
});
