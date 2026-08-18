import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  checkProjectAccess: vi.fn(),
  isImageProviderConfigured: vi.fn(),
}));

vi.mock("../../lib/auth", () => ({ checkProjectAccess: mocks.checkProjectAccess }));
vi.mock("../../lib/image-provider", () => ({
  isImageProviderConfigured: mocks.isImageProviderConfigured,
}));
vi.mock("../../lib/image-generation-jobs", () => ({
  enqueueImageJob: vi.fn(),
  getJob: vi.fn(),
  preflightImageJobs: vi.fn(),
  enqueueImageEditJob: vi.fn(),
}));
vi.mock("../../lib/image-storage", () => ({
  storeUploadedImage: vi.fn(),
  getImageBuffer: vi.fn(),
}));
vi.mock("../../lib/public-ai/authed-user", () => ({ resolveTierForUser: vi.fn() }));
vi.mock("../../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: vi.fn(),
  refundOraQuota: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function appFor(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "requesting-user";
    next();
  });
  app.use(router);
  return app;
}

describe("authorization lockdown: image project association", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkProjectAccess.mockResolvedValue("denied");
  });

  it("denies POST /images/generate for another user's project", async () => {
    const router = (await import("../image-gen")).default;
    const response = await request(appFor(router))
      .post("/images/generate")
      .send({ prompt: "A landscape", projectId: 901 });

    expect(response.status).toBe(404);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith("requesting-user", 901, "member");
    expect(mocks.isImageProviderConfigured).not.toHaveBeenCalled();
  });

  it("denies POST /images/:id/edit for another user's project", async () => {
    const router = (await import("../image-gen")).default;
    const response = await request(appFor(router))
      .post("/images/12/edit")
      .send({ instruction: "Change the background", projectId: 902 });

    expect(response.status).toBe(404);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith("requesting-user", 902, "member");
    expect(mocks.isImageProviderConfigured).not.toHaveBeenCalled();
  });
});
