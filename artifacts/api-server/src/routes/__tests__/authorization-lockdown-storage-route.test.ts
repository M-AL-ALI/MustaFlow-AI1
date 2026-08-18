import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getObjectEntityFile: vi.fn(),
  canAccessObjectEntity: vi.fn(),
  downloadObject: vi.fn(),
}));

vi.mock("../../lib/objectStorage", () => ({
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  ObjectStorageService: class ObjectStorageService {
    getObjectEntityFile = mocks.getObjectEntityFile;
    canAccessObjectEntity = mocks.canAccessObjectEntity;
    downloadObject = mocks.downloadObject;
    getObjectEntityUploadURL = vi.fn();
    normalizeObjectEntityPath = vi.fn();
    searchPublicObject = vi.fn();
  },
}));

describe("authorization lockdown: private object hostile path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getObjectEntityFile.mockResolvedValue({ name: "objects/foreign/report.pdf" });
    mocks.canAccessObjectEntity.mockResolvedValue(false);
  });

  it("denies GET /storage/objects/* when the requesting user lacks an ACL", async () => {
    const router = (await import("../storage")).default;
    const app = express();
    app.use((req, _res, next) => {
      req.userId = "requesting-user";
      req.log = { error: vi.fn(), warn: vi.fn() } as never;
      next();
    });
    app.use(router);

    const response = await request(app).get("/storage/objects/foreign/report.pdf");

    expect(response.status).toBe(404);
    expect(mocks.canAccessObjectEntity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "requesting-user" }),
    );
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it("serves GET /storage/objects/* when the requesting user has a read ACL", async () => {
    mocks.canAccessObjectEntity.mockResolvedValue(true);
    mocks.downloadObject.mockResolvedValue(new Response("private object"));
    const router = (await import("../storage")).default;
    const app = express();
    app.use((req, _res, next) => {
      req.userId = "authorized-user";
      req.log = { error: vi.fn(), warn: vi.fn() } as never;
      next();
    });
    app.use(router);

    const response = await request(app).get("/storage/objects/owned/report.pdf");

    expect(response.status).toBe(200);
    expect(response.text).toBe("private object");
    expect(mocks.canAccessObjectEntity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "authorized-user" }),
    );
  });
});
