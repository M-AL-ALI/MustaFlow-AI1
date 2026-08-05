import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  editImage: vi.fn(),
  refundOraQuota: vi.fn(),
}));

vi.mock("../../../lib/public-ai/session", () => ({
  validateSession: vi.fn(() => ({ sessionId: "image-edit-session", msgCount: 0 })),
  incrementMessageCount: vi.fn((session) => ({
    token: "next-token",
    payload: { ...session, msgCount: session.msgCount + 1 },
  })),
  setSessionCookie: vi.fn(),
}));

vi.mock("../../../lib/public-ai/image-store", () => ({
  getImage: vi.fn(() => ({
    sessionId: "image-edit-session",
    filename: "upload.png",
    mimeType: "image/png",
    sizeBytes: 3,
    width: 100,
    height: 100,
    base64: Buffer.from("src").toString("base64"),
  })),
}));

vi.mock("../../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn(async () => ({ userId: "ora-user", tier: "core" })),
}));

vi.mock("../../../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: vi.fn(async () => ({ allowed: true, used: 1, limit: 10, resetsAt: null })),
  refundOraQuota: mocks.refundOraQuota,
  oraMessageFields: vi.fn(async () => ({
    msgCount: 1,
    msgLimit: 100,
    imageCount: 1,
    imageLimit: 10,
  })),
}));

vi.mock("../../../lib/public-ai/ora-spend-cap", () => ({
  checkOraSpendCapAsync: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../../../lib/image-provider", () => ({
  isImageProviderConfigured: vi.fn(() => true),
  editImage: mocks.editImage,
}));

import imageEditRouter from "../image-edit";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.cookies = { "ora-session": "session-token" };
    next();
  });
  instance.use(imageEditRouter);
  return instance;
}

describe("uploaded image edit round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editImage.mockResolvedValue({
      openaiUrl: "data:image/png;base64,ZWRpdGVk",
      mimeType: "image/png",
    });
  });

  it("returns an edited image only after the provider produces image bytes", async () => {
    const response = await request(app()).post("/public-ai/image-edit").send({
      imageRef: "10f2e5a0-1b4c-4e78-9e8d-2db3f4b32d42",
      message: "Make the background blue",
    });

    expect(response.status).toBe(200);
    expect(response.body.imageUrl).toBe("data:image/png;base64,ZWRpdGVk");
    expect(response.body.reply).toBe("Here's the edited image.");
    expect(mocks.editImage).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: "Make the background blue" }),
    );
  });

  it("reports an honest failure without image or delivery claims", async () => {
    mocks.editImage.mockRejectedValueOnce(new Error("provider unavailable"));
    const response = await request(app()).post("/public-ai/image-edit").send({
      imageRef: "10f2e5a0-1b4c-4e78-9e8d-2db3f4b32d42",
      message: "Make the background blue",
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("No edited image was created");
    expect(response.body.reply).toBeUndefined();
    expect(response.body.imageUrl).toBeUndefined();
    expect(mocks.refundOraQuota).toHaveBeenCalledWith("ora-user", "image");
  });
});
