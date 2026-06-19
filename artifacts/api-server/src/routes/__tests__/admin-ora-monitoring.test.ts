/**
 * Wave 2B — Ora Monitoring + Admin Visibility tests
 *
 * Covers:
 *   - Admin can view the monitoring snapshot (200)
 *   - Non-admin users are blocked (403)
 *   - Anonymous requests are blocked (401)
 *   - Response shape contains spend, kill-switch, provider-health sections
 *   - No raw prompts, user text, file contents, secrets, or stack traces
 *   - No Builder/handoff language in any response field
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

// ── Mock requireAdmin ──────────────────────────────────────────────────────────

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

// ── Mock spend-cap module ──────────────────────────────────────────────────────

vi.mock("../../lib/public-ai/ora-spend-cap", () => ({
  getSpendCapSnapshot: vi.fn(() => ({
    dateKey: "2026-06-19",
    globalUnits: 1200,
    globalCap: 10000,
    userCap: 500,
    anonIpCap: 50,
    featureUnits: { chat: 800, web_search: 400 },
    ledgerActive: true,
    periodicSyncActive: true,
  })),
  FEATURE_UNITS: {
    chat: 1,
    streaming_chat: 1,
    file_analysis: 3,
    dataset_analysis: 5,
    image_analysis: 3,
    tts_voice: 1,
    transcribe: 1,
    file_generation: 3,
    web_search: 2,
    remember_document: 2,
  },
}));

// ── Mock kill-switch module ────────────────────────────────────────────────────

vi.mock("../../lib/public-ai/ora-kill-switches", () => ({
  isKillSwitchActive: vi.fn((feature: string) => feature === "tts"),
}));

// ── Mock model-router ──────────────────────────────────────────────────────────

vi.mock("../../lib/public-ai/model-router", () => ({
  getOraProviderRoutingSnapshot: vi.fn(() => ({
    openCircuits: new Set(["anthropic"]),
    available: { openai: true, anthropic: false, gemini: true, deepseek: true },
  })),
}));

// ── Mock @workspace/db (pool only) ────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({
        rows: [
          { ledger_key: "global", units: 1200 },
          { ledger_key: "feature:chat", units: 800 },
          { ledger_key: "feature:web_search", units: 400 },
          { ledger_key: "user:user-abc", units: 300 },
          { ledger_key: "user:user-def", units: 900 },
          { ledger_key: "ip:192.168", units: 100 },
        ],
      }),
      release: vi.fn(),
    }),
  },
}));

import adminOraMonitoringRouter from "../admin-ora-monitoring";

// ── App factory ───────────────────────────────────────────────────────────────

function appAs(userId: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.userId = userId;
    next();
  });
  app.use("/api", adminOraMonitoringRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/admin/ora/monitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for anonymous requests", async () => {
    const res = await request(appAs(null)).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin authenticated users", async () => {
    const res = await request(appAs("regular-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(403);
  });

  it("returns 200 with monitoring snapshot for admin", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("includes a valid asOf ISO timestamp", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    expect(typeof res.body.asOf).toBe("string");
    expect(new Date(res.body.asOf).getTime()).toBeGreaterThan(0);
  });

  it("includes spend section with global units and cap", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const { spend } = res.body;
    expect(spend).toBeDefined();
    expect(typeof spend.globalUnits).toBe("number");
    expect(typeof spend.globalCap).toBe("number");
    expect(typeof spend.globalPct).toBe("number");
    expect(spend.globalPct).toBe(12); // 1200/10000 = 12%
    expect(spend.ledgerActive).toBe(true);
    expect(spend.dateKey).toBe("2026-06-19");
  });

  it("includes byFeature breakdown in spend", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const { spend } = res.body;
    expect(spend.byFeature).toBeDefined();
    expect(typeof spend.byFeature).toBe("object");
  });

  it("includes DB spend summary with feature breakdown and aggregate counts", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const { dbSpend } = res.body;
    expect(dbSpend).toBeDefined();
    expect(dbSpend.available).toBe(true);
    expect(dbSpend.globalUnits).toBe(1200);
    expect(dbSpend.uniqueUserCount).toBe(2);
    expect(dbSpend.uniqueIpCount).toBe(1);
    expect(Array.isArray(dbSpend.featureBreakdown)).toBe(true);
    expect(dbSpend.featureBreakdown.length).toBeGreaterThan(0);
    const chatEntry = dbSpend.featureBreakdown.find(
      (e: { feature: string }) => e.feature === "chat",
    );
    expect(chatEntry).toBeDefined();
    expect(chatEntry.units).toBe(800);
  });

  it("includes kill switch status for all features", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const { killSwitches } = res.body;
    expect(killSwitches).toBeDefined();
    // "all" feature key must be present
    expect(typeof killSwitches.all).toBe("boolean");
    // "tts" is mocked as active
    expect(killSwitches.tts).toBe(true);
    // others are inactive
    expect(killSwitches.streaming).toBe(false);
  });

  it("includes provider health with openCircuits and availability", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const { providerHealth } = res.body;
    expect(providerHealth).toBeDefined();
    expect(Array.isArray(providerHealth.openCircuits)).toBe(true);
    expect(providerHealth.openCircuits).toContain("anthropic");
    expect(typeof providerHealth.available).toBe("object");
    expect(providerHealth.available.openai).toBe(true);
    expect(providerHealth.available.anthropic).toBe(false);
  });

  it("never exposes raw user text, file contents, or secrets", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    // No user IDs surfaced in dbSpend section
    expect(body).not.toMatch(/user-abc|user-def/);
    // No IP addresses surfaced
    expect(body).not.toMatch(/192\.168/);
    // No raw prompt text
    expect(body).not.toMatch(/rawPrompt|userMessage|fileContent/i);
    // No stack traces
    expect(body).not.toMatch(/at Object\.|at async /);
  });

  it("contains no Builder or handoff language", async () => {
    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toContain("builder");
    expect(body).not.toContain("handoff");
    expect(body).not.toContain("mustaflow builder");
    expect(body).not.toContain("continue in builder");
    expect(body).not.toContain("ready to build");
  });

  it("degraded DB path: returns available:false when pool.connect() fails", async () => {
    const { pool } = await import("@workspace/db");
    vi.mocked(pool.connect).mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(appAs("admin-user")).get("/api/admin/ora/monitoring");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Core spend snapshot still comes from in-memory; only dbSpend is degraded.
    expect(res.body.dbSpend.available).toBe(false);
    expect(typeof res.body.dbSpend.error).toBe("string");
    // Spend section should still be present from in-memory
    expect(res.body.spend.globalUnits).toBe(1200);
  });
});
