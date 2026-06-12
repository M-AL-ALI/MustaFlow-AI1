import { describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

vi.mock("../../lib/adminAuth", () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    if (!req.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (req.userId !== "admin-user") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
}));

import adminOraRoutingDiagnosticsRouter from "../admin-ora-routing-diagnostics";

function appAs(userId: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.userId = userId;
    next();
  });
  app.use("/api", adminOraRoutingDiagnosticsRouter);
  return app;
}

describe("POST /api/admin/ora-routing/diagnostics", () => {
  it("requires admin access", async () => {
    const anonymous = await request(appAs(null))
      .post("/api/admin/ora-routing/diagnostics")
      .send({ message: "what can Ora do?" });
    expect(anonymous.status).toBe(401);

    const nonAdmin = await request(appAs("regular-user"))
      .post("/api/admin/ora-routing/diagnostics")
      .send({ message: "what can Ora do?" });
    expect(nonAdmin.status).toBe(403);
  });

  it("returns a conversational routing diagnostic for a real prompt", async () => {
    const res = await request(appAs("admin-user"))
      .post("/api/admin/ora-routing/diagnostics")
      .send({
        message: "debug a Node API performance issue",
        subscriptionTier: "core",
        classifier: {
          intent: "premium",
          confidence: "high",
          topic: "technical",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.diagnostic).toMatchObject({
      surface: "auto",
      planTier: "core",
      tool: "answer",
      access: { allowed: true },
      quotaKind: "message",
      usesRollingQuota: true,
      routeTier: "premium",
      terminalProvider: "openai",
    });
    expect(res.body.diagnostic.providerOrder).toEqual([
      "anthropic",
      "deepseek",
      "gemini",
      "openai",
    ]);
  });

  it("uses a deterministic classifier by default", async () => {
    const res = await request(appAs("admin-user")).post("/api/admin/ora-routing/diagnostics").send({
      message: "explain product positioning for a SaaS app",
      subscriptionTier: "core",
    });

    expect(res.status).toBe(200);
    expect(res.body.diagnostic.decision).toMatchObject({
      intent: "premium",
      confidence: "high",
      topic: "general",
    });
    expect(res.body.diagnostic.providerOrder).toEqual([
      "anthropic",
      "gemini",
      "deepseek",
      "openai",
    ]);
  });

  it("diagnoses explicit specialist surfaces and provider availability", async () => {
    const res = await request(appAs("admin-user"))
      .post("/api/admin/ora-routing/diagnostics")
      .send({
        surface: "vision_analysis",
        message: "what is in this uploaded image?",
        subscriptionTier: "wave",
        available: { gemini: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.diagnostic.tool).toBe("image_analysis");
    expect(res.body.diagnostic.providerOrder).toEqual(["anthropic", "openai"]);
    expect(res.body.diagnostic.providerOrder).not.toContain("deepseek");
  });

  it("rejects invalid diagnostic input", async () => {
    const res = await request(appAs("admin-user")).post("/api/admin/ora-routing/diagnostics").send({
      message: "",
      surface: "unknown",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.issues.length).toBeGreaterThan(0);
  });
});
