/**
 * Route tests for POST /public-ai/export-file — the deterministic, no-charge
 * mobile export endpoint. Verifies validation, auth gating, and that a real
 * Office file (ZIP-signature) is returned without consuming Ora quota.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

const authState = vi.hoisted(() => ({
  user: null as null | { userId: string; tier: string; isPaid: boolean },
}));

vi.mock("../../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn(async () => authState.user),
}));

import exportFileRouter from "../export-file";
import { createSession } from "../../../lib/public-ai/session";

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { log: { info: () => void; warn: () => void; error: () => void } }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    next();
  });
  app.use(exportFileRouter);
  return app;
}

function isZip(b: Buffer): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

describe("POST /public-ai/export-file", () => {
  beforeEach(() => {
    authState.user = null;
  });

  it("returns 400 for an invalid body", async () => {
    authState.user = { userId: "u1", tier: "free", isPaid: false };
    const res = await request(makeApp())
      .post("/public-ai/export-file")
      .send({ format: "txt", content: "hi" });
    expect(res.status).toBe(400);
  });

  it("returns 401 when there is no authed user and no session", async () => {
    const res = await request(makeApp())
      .post("/public-ai/export-file")
      .send({ format: "docx", content: "# Hello\n\nWorld" });
    expect(res.status).toBe(401);
  });

  it("returns a real .docx for an authed user", async () => {
    authState.user = { userId: "u1", tier: "free", isPaid: false };
    const res = await request(makeApp())
      .post("/public-ai/export-file")
      .send({ format: "docx", title: "My Report", content: "# Hello\n\nWorld" });
    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe("ora-export.docx");
    expect(res.body.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(isZip(Buffer.from(res.body.fileData, "base64"))).toBe(true);
  });

  it("returns a real .xlsx with the requested filename, sanitized", async () => {
    authState.user = { userId: "u1", tier: "free", isPaid: false };
    const res = await request(makeApp()).post("/public-ai/export-file").send({
      format: "xlsx",
      content: "| A | B |\n| - | - |\n| 1 | 2 |",
      filename: "weird/name.xlsx",
    });
    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe("weird_name.xlsx");
    expect(res.body.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(isZip(Buffer.from(res.body.fileData, "base64"))).toBe(true);
  });

  it("accepts a valid anonymous ora-session cookie (no authed user)", async () => {
    const { token } = createSession();
    const res = await request(makeApp())
      .post("/public-ai/export-file")
      .set("Cookie", `ora-session=${token}`)
      .send({ format: "docx", content: "# Hello\n\nWorld" });
    expect(res.status).toBe(200);
    expect(isZip(Buffer.from(res.body.fileData, "base64"))).toBe(true);
  });

  it("returns a real .pptx", async () => {
    authState.user = { userId: "u1", tier: "free", isPaid: false };
    const res = await request(makeApp())
      .post("/public-ai/export-file")
      .send({ format: "pptx", content: "# Slide One\n\n- point a\n- point b" });
    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe("ora-export.pptx");
    expect(isZip(Buffer.from(res.body.fileData, "base64"))).toBe(true);
  });
});
