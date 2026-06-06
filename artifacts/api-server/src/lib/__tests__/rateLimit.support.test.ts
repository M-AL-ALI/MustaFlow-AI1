/**
 * Rate-limiter coverage for the Help Center support endpoints.
 *
 * The help.test.ts functional suite mocks these limiters to pass-through so it
 * can fire many requests; this file exercises the REAL limiter middleware to
 * prove that escalation (ticket creation) is capped per IP per window.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { supportEscalateLimiter, supportChatLimiter } from "../rateLimit";

function appWith(mw: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post("/x", mw, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  return app;
}

describe("supportEscalateLimiter", () => {
  it("allows up to 5 requests then returns 429", async () => {
    const app = appWith(supportEscalateLimiter);
    // A unique source IP so this test's window is isolated from any other.
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) {
      const ok = await request(app).post("/x").set("x-forwarded-for", ip).send({});
      expect(ok.status).toBe(201);
    }
    const blocked = await request(app).post("/x").set("x-forwarded-for", ip).send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
  });
});

describe("supportChatLimiter", () => {
  it("allows up to 20 requests then returns 429", async () => {
    const app = appWith(supportChatLimiter);
    const ip = "203.0.113.51";
    for (let i = 0; i < 20; i++) {
      const ok = await request(app).post("/x").set("x-forwarded-for", ip).send({});
      expect(ok.status).toBe(201);
    }
    const blocked = await request(app).post("/x").set("x-forwarded-for", ip).send({});
    expect(blocked.status).toBe(429);
  });
});
