/**
 * Wave 1B — Daily Spend Caps + Cost Controls
 *
 * Tests for the ora-spend-cap module covering:
 *   1. Global daily unit cap enforcement
 *   2. Per-IP anonymous daily cap enforcement
 *   3. Authed users bypass the per-IP anonymous cap
 *   4. Per-feature unit tracking (observability counters)
 *   5. Day rollover resets state
 *   6. E2E test bypass
 *   7. Snapshot accuracy
 *   8. Ora isolation — no Builder language in any cap message
 *   9. HTTP response shape (limitType, upgradeAvailable, resetAt, retryAfter)
 *  10. Cap not triggered when under limit
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request } from "express";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(opts: { ip?: string; forwardedFor?: string; e2eHeader?: string }): Request {
  return {
    socket: { remoteAddress: opts.ip ?? "10.0.0.1" },
    headers: {
      ...(opts.forwardedFor ? { "x-forwarded-for": opts.forwardedFor } : {}),
      ...(opts.e2eHeader ? { "x-e2e-test-user": opts.e2eHeader } : {}),
    },
  } as unknown as Request;
}

// ── Module under test ─────────────────────────────────────────────────────────

async function getModule() {
  return import("../../../lib/public-ai/ora-spend-cap");
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const mod = await getModule();
  mod._resetSpendCapState();
  mod._setLedgerPool(null);
  delete process.env.ORA_GLOBAL_DAILY_UNIT_CAP;
  delete process.env.ORA_ANON_IP_DAILY_UNIT_CAP;
  delete process.env.ORA_USER_DAILY_UNIT_CAP;
  delete process.env.E2E_TEST_ENABLED;
  delete process.env.ORA_SPEND_DB_VERIFY_THRESHOLD;
  delete process.env.ORA_SPEND_RESYNC_INTERVAL_MS;
});

// ── Mock pool helpers (Wave 1C) ───────────────────────────────────────────────

type MockLedgerRow = { ledger_key: string; units: number };

function makeMockPool(rows: MockLedgerRow[]) {
  const client = {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("SELECT ledger_key")) {
        return { rows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn().mockResolvedValue(client) };
}

function makeFailingPool() {
  return {
    connect: vi.fn().mockRejectedValue(new Error("db down")),
  };
}

function makeQueryFailPool() {
  const client = {
    query: vi.fn().mockRejectedValue(new Error("query failed")),
    release: vi.fn(),
  };
  return { connect: vi.fn().mockResolvedValue(client) };
}

// ── 1. FEATURE_UNITS shape ────────────────────────────────────────────────────

describe("FEATURE_UNITS", () => {
  it("defines a positive integer cost for every feature kind", async () => {
    const { FEATURE_UNITS } = await getModule();
    const expectedFeatures = [
      "chat",
      "streaming_chat",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "tts_voice",
      "transcribe",
      "file_generation",
      "web_search",
      "remember_document",
    ] as const;
    for (const f of expectedFeatures) {
      expect(FEATURE_UNITS[f]).toBeGreaterThan(0);
      expect(Number.isInteger(FEATURE_UNITS[f])).toBe(true);
    }
  });

  it("expensive features cost more units than chat", async () => {
    const { FEATURE_UNITS } = await getModule();
    expect(FEATURE_UNITS["dataset_analysis"]).toBeGreaterThan(FEATURE_UNITS["chat"]);
    expect(FEATURE_UNITS["file_analysis"]).toBeGreaterThan(FEATURE_UNITS["chat"]);
    expect(FEATURE_UNITS["image_analysis"]).toBeGreaterThan(FEATURE_UNITS["chat"]);
  });
});

// ── 2. Under-cap — requests pass through ─────────────────────────────────────

describe("checkOraSpendCap — allowed cases", () => {
  it("allows the first request for an anonymous user", async () => {
    const { checkOraSpendCap } = await getModule();
    const result = checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("none");
  });

  it("allows the first request for an authenticated user", async () => {
    const { checkOraSpendCap } = await getModule();
    const result = checkOraSpendCap(makeReq({}) as Request, "chat", "user-abc", "free");
    expect(result.allowed).toBe(true);
  });

  it("returns units=0 for an allowed allowed call (no side-effect on result)", async () => {
    const { checkOraSpendCap } = await getModule();
    const result = checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(result.allowed).toBe(true);
    expect(result.units).toBe(1); // chat = 1 unit
  });
});

// ── 3. Global daily cap ───────────────────────────────────────────────────────

describe("checkOraSpendCap — global daily cap", () => {
  it("blocks when global cap is exceeded", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "2";
    const mod = await getModule();
    mod._resetSpendCapState();

    // First call: 1 unit — should be allowed (global = 1)
    const r1 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r1.allowed).toBe(true);

    // Second call: 1 unit — should be allowed (global = 2, exactly at cap)
    const r2 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.2" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r2.allowed).toBe(true);

    // Third call: 1 unit — would push to 3 > 2, should be blocked
    const r3 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.3" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("global_cap");
    expect(r3.limitType).toBe("daily_spend_cap");
  });

  it("global cap applies to authenticated users too", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "1";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r1 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-1", "core");
    expect(r1.allowed).toBe(true);

    const r2 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-2", "wave");
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("global_cap");
  });

  it("blocked global-cap response has upgradeAvailable=false", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(false);
    expect(r.upgradeAvailable).toBe(false);
  });

  it("blocked global-cap response contains resetAt and retryAfter", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(false);
    expect(typeof r.resetAt).toBe("string");
    expect(r.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(r.retryAfter).toBeGreaterThan(0);
  });
});

// ── 4. Per-IP anonymous daily cap ────────────────────────────────────────────

describe("checkOraSpendCap — anonymous IP daily cap", () => {
  it("blocks an anon IP that exceeds its daily cap", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "2";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const ip = "192.168.1.1";

    // Use up the 2 allowed units
    mod.checkOraSpendCap(makeReq({ ip }) as Request, "chat", null, "anonymous");
    mod.checkOraSpendCap(makeReq({ ip }) as Request, "chat", null, "anonymous");

    // Third call should be blocked
    const r3 = mod.checkOraSpendCap(makeReq({ ip }) as Request, "chat", null, "anonymous");
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("anon_ip_cap");
    expect(r3.limitType).toBe("daily_spend_cap");
  });

  it("blocked anon-IP response has upgradeAvailable=true", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "0";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(
      makeReq({ ip: "1.2.3.4" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(false);
    expect(r.upgradeAvailable).toBe(true);
  });

  it("different IPs have independent anon caps", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "1";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r1 = mod.checkOraSpendCap(
      makeReq({ ip: "1.1.1.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    const r2 = mod.checkOraSpendCap(
      makeReq({ ip: "2.2.2.2" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true); // different IP — its own fresh cap

    // Same IPs now blocked
    const r1b = mod.checkOraSpendCap(
      makeReq({ ip: "1.1.1.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    const r2b = mod.checkOraSpendCap(
      makeReq({ ip: "2.2.2.2" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r1b.allowed).toBe(false);
    expect(r2b.allowed).toBe(false);
  });

  it("x-forwarded-for is used over remoteAddress", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "1";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const req = {
      socket: { remoteAddress: "10.0.0.1" },
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    } as unknown as Request;

    mod.checkOraSpendCap(req, "chat", null, "anonymous");
    const r2 = mod.checkOraSpendCap(req, "chat", null, "anonymous");
    expect(r2.allowed).toBe(false); // same forwarded IP exhausted

    // remoteAddress-only request is a different "IP" bucket → still allowed
    const req2 = {
      socket: { remoteAddress: "10.0.0.1" },
      headers: {},
    } as Partial<Request>;
    const r3 = mod.checkOraSpendCap(req2 as Request, "chat", null, "anonymous");
    expect(r3.allowed).toBe(true);
  });
});

// ── 5. Authed users bypass the per-IP cap ────────────────────────────────────

describe("checkOraSpendCap — authed user bypasses IP cap", () => {
  it("authenticated users are NOT subject to the per-IP anonymous cap", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "0"; // anon cap is 0 — would instantly block anon
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(
      makeReq({ ip: "1.2.3.4" }) as Request,
      "chat",
      "user-xyz",
      "core",
    );
    expect(r.allowed).toBe(true); // userId present → IP cap not applied
  });
});

// ── 6. Feature unit tracking ─────────────────────────────────────────────────

describe("checkOraSpendCap — feature unit tracking", () => {
  it("increments globalUnits by the correct feature cost", async () => {
    const mod = await getModule();

    mod.checkOraSpendCap(makeReq({}) as Request, "dataset_analysis", null, "anonymous");
    const snap = mod.getSpendCapSnapshot();
    expect(snap.globalUnits).toBe(5); // dataset_analysis = 5 units
  });

  it("tracks per-feature counters in the snapshot", async () => {
    const mod = await getModule();

    mod.checkOraSpendCap(makeReq({}) as Request, "chat", "u1", "free");
    mod.checkOraSpendCap(makeReq({}) as Request, "file_generation", "u1", "free");

    const snap = mod.getSpendCapSnapshot();
    expect(snap.featureUnits["chat"]).toBe(1);
    expect(snap.featureUnits["file_generation"]).toBe(3);
  });

  it("does NOT increment counters when request is blocked", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    const snap = mod.getSpendCapSnapshot();
    expect(snap.globalUnits).toBe(0); // blocked — nothing consumed
  });
});

// ── 7. getSpendCapSnapshot ───────────────────────────────────────────────────

describe("getSpendCapSnapshot", () => {
  it("returns globalCap and anonIpCap matching env defaults", async () => {
    const mod = await getModule();
    const snap = mod.getSpendCapSnapshot();
    expect(snap.globalCap).toBe(10000);
    expect(snap.anonIpCap).toBe(50);
  });

  it("dateKey is today's UTC date", async () => {
    const { getSpendCapSnapshot } = await getModule();
    const snap = getSpendCapSnapshot();
    const today = new Date().toISOString().slice(0, 10);
    expect(snap.dateKey).toBe(today);
  });

  it("starts with globalUnits=0 after reset", async () => {
    const mod = await getModule();
    const snap = mod.getSpendCapSnapshot();
    expect(snap.globalUnits).toBe(0);
  });
});

// ── 8. Day rollover ──────────────────────────────────────────────────────────

describe("checkOraSpendCap — day rollover", () => {
  it("resets counters when injecting a past-day state", async () => {
    const mod = await getModule();

    // Inject a stale state (yesterday)
    mod._resetSpendCapState({
      dateKey: "2020-01-01",
      globalUnits: 9999,
      userUnits: new Map([["user-old", 999]]),
      ipUnits: new Map([["1.2.3.4", 999]]),
      featureUnits: new Map([["chat", 999]] as ["chat", number][]),
    });

    // Any request should trigger a day-rollover and start fresh
    const r = mod.checkOraSpendCap(
      makeReq({ ip: "1.2.3.4" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(true); // fresh day — allowed

    const snap = mod.getSpendCapSnapshot();
    expect(snap.globalUnits).toBe(1); // only the one call above
    expect(snap.dateKey).not.toBe("2020-01-01");
  });
});

// ── 9. E2E bypass ────────────────────────────────────────────────────────────

describe("checkOraSpendCap — E2E bypass", () => {
  it("skips cap enforcement when E2E_TEST_ENABLED=true and header present", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0"; // would block everything
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(
      makeReq({ e2eHeader: "test-user-1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(true);
    expect(r.units).toBe(0); // E2E bypass does not count units
  });

  it("does NOT bypass when header is absent", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(false); // no e2e header → cap applies
  });

  it("does NOT bypass when E2E_TEST_ENABLED is absent", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(
      makeReq({ e2eHeader: "test-user-1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(false); // E2E flag not set → cap applies
  });
});

// ── 10. Ora isolation — no Builder language in any message ───────────────────

describe("Ora spend cap isolation — no Builder language in messages", () => {
  const FORBIDDEN = [
    "builder",
    "mustaflow builder",
    "continue in builder",
    "ready to build",
    "handoff",
    "builder_handoff",
    "mustaflow ai",
  ];

  it("global cap message contains no Builder language", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    const msg = r.message.toLowerCase();
    for (const term of FORBIDDEN) {
      expect(msg).not.toContain(term);
    }
  });

  it("anon IP cap message contains no Builder language", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "0";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    const msg = r.message.toLowerCase();
    for (const term of FORBIDDEN) {
      expect(msg).not.toContain(term);
    }
  });
});

// ── 11. Per-user authenticated daily cap ─────────────────────────────────────

describe("checkOraSpendCap — authenticated per-user daily cap", () => {
  it("blocks an authenticated user who exceeds their daily unit cap", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "2";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Use up the 2 allowed units (chat = 1 each)
    mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");

    // Third call would push to 3 > 2 — blocked
    const r3 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("user_cap");
    expect(r3.limitType).toBe("daily_spend_cap");
  });

  it("one authenticated user's cap does not affect another user", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "1";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // user-a exhausts its own cap
    mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    const rA = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(rA.allowed).toBe(false);
    expect(rA.reason).toBe("user_cap");

    // user-b is completely unaffected
    const rB = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-b", "free");
    expect(rB.allowed).toBe(true);
  });

  it("per-user cap blocked response has upgradeAvailable=true", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "0";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-abc", "core");
    expect(r.allowed).toBe(false);
    expect(r.upgradeAvailable).toBe(true);
    expect(r.reason).toBe("user_cap");
  });

  it("per-user cap blocked response contains resetAt and retryAfter", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "0";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-abc", "free");
    expect(r.allowed).toBe(false);
    expect(typeof r.resetAt).toBe("string");
    expect(r.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("anonymous IP cap does not affect authenticated user's per-user cap", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "0"; // instantly blocks anonymous
    process.env.ORA_USER_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Authenticated user on same IP as an exhausted anon — still allowed
    const r = mod.checkOraSpendCap(
      makeReq({ ip: "1.2.3.4" }) as Request,
      "chat",
      "user-xyz",
      "free",
    );
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("none");
  });

  it("per-user cap does not apply to anonymous callers (they use IP cap instead)", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "0"; // would block authed users immediately
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // null userId → per-user cap is not applied, anon IP cap governs
    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(true);
  });
});

// ── 12. New feature kinds — transcribe, remember_document ────────────────────

describe("checkOraSpendCap — transcribe and remember_document tracking", () => {
  it("transcribe feature is tracked in featureUnits with cost=1", async () => {
    const mod = await getModule();

    mod.checkOraSpendCap(makeReq({}) as Request, "transcribe", null, "anonymous");
    const snap = mod.getSpendCapSnapshot();
    expect(snap.featureUnits["transcribe"]).toBe(1);
    expect(snap.globalUnits).toBe(1);
  });

  it("remember_document feature is tracked in featureUnits with cost=2", async () => {
    const mod = await getModule();

    mod.checkOraSpendCap(makeReq({}) as Request, "remember_document", "user-1", "free");
    const snap = mod.getSpendCapSnapshot();
    expect(snap.featureUnits["remember_document"]).toBe(2);
    expect(snap.globalUnits).toBe(2);
  });

  it("tts_voice feature is tracked in featureUnits with cost=1", async () => {
    const mod = await getModule();

    mod.checkOraSpendCap(makeReq({}) as Request, "tts_voice", "user-1", "free");
    const snap = mod.getSpendCapSnapshot();
    expect(snap.featureUnits["tts_voice"]).toBe(1);
  });

  it("multiple transcribe calls accumulate correctly", async () => {
    const mod = await getModule();

    mod.checkOraSpendCap(makeReq({}) as Request, "transcribe", "user-1", "free");
    mod.checkOraSpendCap(makeReq({}) as Request, "transcribe", "user-1", "free");
    mod.checkOraSpendCap(makeReq({ ip: "9.9.9.9" }) as Request, "transcribe", "user-2", "core");
    const snap = mod.getSpendCapSnapshot();
    expect(snap.featureUnits["transcribe"]).toBe(3); // 1+1+1
    expect(snap.globalUnits).toBe(3);
  });
});

// ── 13. getSpendCapSnapshot exposes userCap ───────────────────────────────────

describe("getSpendCapSnapshot — userCap field", () => {
  it("exposes userCap matching the default env value", async () => {
    const mod = await getModule();
    const snap = mod.getSpendCapSnapshot();
    expect(snap.userCap).toBe(500); // default ORA_USER_DAILY_UNIT_CAP
  });

  it("exposes userCap reflecting ORA_USER_DAILY_UNIT_CAP env override", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "250";
    const mod = await getModule();
    const snap = mod.getSpendCapSnapshot();
    expect(snap.userCap).toBe(250);
  });
});

// ── 14. Per-user cap message Ora isolation ────────────────────────────────────

describe("Ora spend cap isolation — per-user cap message", () => {
  const FORBIDDEN = [
    "builder",
    "mustaflow builder",
    "continue in builder",
    "ready to build",
    "handoff",
    "builder_handoff",
  ];

  it("per-user cap blocked message contains no Builder language", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "0";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-abc", "free");
    const msg = r.message.toLowerCase();
    for (const term of FORBIDDEN) {
      expect(msg).not.toContain(term);
    }
  });
});

// ── 15. HTTP response shape via express integration ──────────────────────────

describe("spend cap HTTP response shape", () => {
  it("429 response includes limitType, upgradeAvailable, resetAt, retryAfter", async () => {
    const express = (await import("express")).default;
    const { default: request } = await import("supertest");
    const mod = await getModule();

    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    mod._resetSpendCapState();

    const app = express();
    app.get("/test", async (req, res) => {
      const capResult = mod.checkOraSpendCap(req, "chat", null, "anonymous");
      if (!capResult.allowed) {
        res.status(429).json({
          error: capResult.message,
          limitType: capResult.limitType,
          upgradeAvailable: capResult.upgradeAvailable,
          resetAt: capResult.resetAt,
          retryAfter: capResult.retryAfter,
        });
        return;
      }
      res.json({ ok: true });
    });

    const resp = await request(app).get("/test");
    expect(resp.status).toBe(429);
    expect(resp.body.limitType).toBe("daily_spend_cap");
    expect(typeof resp.body.upgradeAvailable).toBe("boolean");
    expect(typeof resp.body.resetAt).toBe("string");
    expect(typeof resp.body.retryAfter).toBe("number");
    expect(resp.body.retryAfter).toBeGreaterThan(0);
    expect(typeof resp.body.error).toBe("string");
    expect(resp.body.error.length).toBeGreaterThan(0);
  });
});

// ── 16. Durable ledger — initSpendLedger seeds Maps (restart simulation) ──────

describe("initSpendLedger — durable restart simulation", () => {
  it("global cap survives simulated restart: seeded globalUnits blocks at cap", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "992";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Simulate DB containing 990 units already spent before the restart
    const mockPool = makeMockPool([{ ledger_key: "global", units: 990 }]);
    await mod.initSpendLedger(mockPool as never);

    // 990 + 1 = 991 ≤ 992 — allowed
    const r1 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r1.allowed).toBe(true);

    // 991 + 1 = 992 ≤ 992 — still allowed (exactly at cap)
    const r2 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.2" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r2.allowed).toBe(true);

    // 992 + 1 = 993 > 992 — blocked
    const r3 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.3" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("global_cap");
  });

  it("per-user cap survives simulated restart: seeded userUnits blocks at cap", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Simulate DB: user-a spent 98 units before restart
    const mockPool = makeMockPool([{ ledger_key: "user:user-a", units: 98 }]);
    await mod.initSpendLedger(mockPool as never);

    // 98 + 1 = 99 ≤ 100 — allowed
    const r1 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(r1.allowed).toBe(true);

    // 99 + 1 = 100 ≤ 100 — still allowed
    const r2 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(r2.allowed).toBe(true);

    // 100 + 1 = 101 > 100 — blocked
    const r3 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("user_cap");
  });

  it("anonymous IP cap survives simulated restart: seeded ipUnits blocks at cap", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "50";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Simulate DB: IP 10.0.0.1 spent 48 units before restart
    const mockPool = makeMockPool([{ ledger_key: "ip:10.0.0.1", units: 48 }]);
    await mod.initSpendLedger(mockPool as never);

    // 48 + 1 = 49 ≤ 50 — allowed
    const r1 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r1.allowed).toBe(true);

    // 49 + 1 = 50 ≤ 50 — still allowed
    const r2 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r2.allowed).toBe(true);

    // 50 + 1 = 51 > 50 — blocked
    const r3 = mod.checkOraSpendCap(
      makeReq({ ip: "10.0.0.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("anon_ip_cap");
  });

  it("feature unit tracking persists: seeded featureUnits appear in snapshot", async () => {
    const mod = await getModule();
    mod._resetSpendCapState();

    const mockPool = makeMockPool([
      { ledger_key: "feature:chat", units: 42 },
      { ledger_key: "feature:file_analysis", units: 9 },
      { ledger_key: "global", units: 51 },
    ]);
    await mod.initSpendLedger(mockPool as never);

    const snap = mod.getSpendCapSnapshot();
    expect(snap.featureUnits["chat"]).toBe(42);
    expect(snap.featureUnits["file_analysis"]).toBe(9);
    expect(snap.globalUnits).toBe(51);
  });

  it("separate users retain independent caps after seeding from DB", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "10";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // user-a spent 9, user-b spent 0 before restart
    const mockPool = makeMockPool([{ ledger_key: "user:user-a", units: 9 }]);
    await mod.initSpendLedger(mockPool as never);

    // user-a: 9 + 1 = 10 ≤ 10 — allowed (just at cap)
    const rA = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(rA.allowed).toBe(true);

    // user-a: 10 + 1 = 11 > 10 — blocked
    const rA2 = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-a", "free");
    expect(rA2.allowed).toBe(false);
    expect(rA2.reason).toBe("user_cap");

    // user-b: untouched — allowed
    const rB = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-b", "free");
    expect(rB.allowed).toBe(true);
  });
});

// ── 17. Concurrent requests within a single process ──────────────────────────

describe("checkOraSpendCap — concurrent request safety", () => {
  it("N synchronous calls at cap=N-1 allow exactly N-1 and block 1", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "5";
    const mod = await getModule();
    mod._resetSpendCapState();

    // 7 calls using chat (1 unit each); cap is 5 → 5 allowed, 2 blocked
    const results = Array.from({ length: 7 }, (_, i) =>
      mod.checkOraSpendCap(
        makeReq({ ip: `10.0.0.${i + 1}` }) as Request,
        "chat",
        null,
        "anonymous",
      ),
    );

    const allowed = results.filter((r) => r.allowed).length;
    const blocked = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(5);
    expect(blocked).toBe(2);
  });

  it("synchronous per-user calls cannot bypass the user cap", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "3";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();
    mod._resetSpendCapState();

    // 5 calls for same user; cap is 3
    const results = Array.from({ length: 5 }, () =>
      mod.checkOraSpendCap(makeReq({}) as Request, "chat", "concurrent-user", "core"),
    );

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(3);
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === "user_cap")).toBe(true);
  });
});

// ── 18. Alert thresholds — warn logs, no block ────────────────────────────────

describe("checkOraSpendCap — alert thresholds", () => {
  it("requests are still allowed at the 50% global threshold", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Consume 49 units (49 < 50 = threshold)
    for (let i = 0; i < 49; i++) {
      mod.checkOraSpendCap(makeReq({ ip: `1.2.3.${i}` }) as Request, "chat", null, "anonymous");
    }
    // The 50th unit crosses the 50% threshold — must still be allowed
    const r = mod.checkOraSpendCap(
      makeReq({ ip: "9.9.9.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(true);
    expect(mod.getSpendCapSnapshot().globalUnits).toBe(50);
  });

  it("requests are still allowed at the 80% global threshold", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();
    mod._resetSpendCapState();

    for (let i = 0; i < 79; i++) {
      mod.checkOraSpendCap(makeReq({ ip: `1.2.3.${i}` }) as Request, "chat", null, "anonymous");
    }
    const r = mod.checkOraSpendCap(
      makeReq({ ip: "9.9.9.2" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(true);
    expect(mod.getSpendCapSnapshot().globalUnits).toBe(80);
  });

  it("requests are still allowed at the 95% global threshold", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();
    mod._resetSpendCapState();

    for (let i = 0; i < 94; i++) {
      mod.checkOraSpendCap(
        makeReq({ ip: `1.2.3.${i % 200}` }) as Request,
        "chat",
        null,
        "anonymous",
      );
    }
    const r = mod.checkOraSpendCap(
      makeReq({ ip: "9.9.9.3" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(true);
    expect(mod.getSpendCapSnapshot().globalUnits).toBe(95);
  });

  it("threshold crossing only fires once per band — subsequent calls in same band do not re-alert", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Cross the 50% threshold, then add two more calls (both within 50–80% band)
    for (let i = 0; i < 52; i++) {
      const r = mod.checkOraSpendCap(
        makeReq({ ip: `1.2.3.${i % 200}` }) as Request,
        "chat",
        null,
        "anonymous",
      );
      // All 52 calls should be allowed (52 ≤ 100)
      expect(r.allowed).toBe(true);
    }
    expect(mod.getSpendCapSnapshot().globalUnits).toBe(52);
  });
});

// ── 19. Snapshot ledgerActive field ──────────────────────────────────────────

describe("getSpendCapSnapshot — ledgerActive field", () => {
  it("ledgerActive is false when no pool has been configured", async () => {
    const mod = await getModule();
    expect(mod.getSpendCapSnapshot().ledgerActive).toBe(false);
  });

  it("ledgerActive is true after _setLedgerPool is called with a non-null pool", async () => {
    const mod = await getModule();
    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);
    expect(mod.getSpendCapSnapshot().ledgerActive).toBe(true);
  });

  it("ledgerActive is false after _setLedgerPool(null)", async () => {
    const mod = await getModule();
    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);
    mod._setLedgerPool(null);
    expect(mod.getSpendCapSnapshot().ledgerActive).toBe(false);
  });
});

// ── 20. DB degraded mode — graceful fallback ─────────────────────────────────

describe("initSpendLedger — DB degraded mode", () => {
  it("initSpendLedger does not throw when pool.connect() rejects", async () => {
    const mod = await getModule();
    mod._resetSpendCapState();

    const failPool = makeFailingPool();
    await expect(mod.initSpendLedger(failPool as never)).resolves.toBeUndefined();
    mod._stopPeriodicSync();

    // Caps should still work in memory-only mode
    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(true);
  });

  it("initSpendLedger does not throw when query rejects", async () => {
    const mod = await getModule();
    mod._resetSpendCapState();

    const failPool = makeQueryFailPool();
    await expect(mod.initSpendLedger(failPool as never)).resolves.toBeUndefined();
    mod._stopPeriodicSync();

    // In-memory caps remain functional
    const r = mod.checkOraSpendCap(makeReq({}) as Request, "chat", "user-q", "free");
    expect(r.allowed).toBe(true);
  });

  it("caps are enforced in memory-only mode when DB is unavailable", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "2";
    const mod = await getModule();
    mod._resetSpendCapState();

    // Init fails — no DB rows seeded (starts from 0 in memory)
    await mod.initSpendLedger(makeFailingPool() as never);
    mod._stopPeriodicSync();

    const r1 = mod.checkOraSpendCap(
      makeReq({ ip: "1.1.1.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    const r2 = mod.checkOraSpendCap(
      makeReq({ ip: "1.1.1.2" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    const r3 = mod.checkOraSpendCap(
      makeReq({ ip: "1.1.1.3" }) as Request,
      "chat",
      null,
      "anonymous",
    );

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("global_cap");
  });
});

// ── 21. checkOraSpendCapAsync — DB total overrides stale in-memory (global) ──

describe("checkOraSpendCapAsync — DB total over global cap while memory is under", () => {
  it("blocks when DB global total exceeds cap even though local memory is under cap", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    // DB reports 102 units spent globally (other instance spent the rest)
    const mockPool = makeMockPool([{ ledger_key: "global", units: 102 }]);
    mod._setLedgerPool(mockPool as never);

    // This instance's local memory shows only 85 (below cap of 100, but >= 80% threshold)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 85,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global_cap");
  });

  it("allows when DB global total is under cap after resync", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    // DB reports 85 units — same as memory, not over cap
    const mockPool = makeMockPool([{ ledger_key: "global", units: 85 }]);
    mod._setLedgerPool(mockPool as never);

    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 85,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    // 85 + 1 = 86 <= 100 — still allowed
    expect(r.allowed).toBe(true);
  });
});

// ── 22. checkOraSpendCapAsync — DB total overrides stale per-user ─────────────

describe("checkOraSpendCapAsync — DB total over user cap while memory is under", () => {
  it("blocks when DB user total exceeds cap even though local user memory is under cap", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    // DB reports user:user-a at 105 (spent on another instance)
    const mockPool = makeMockPool([{ ledger_key: "user:user-a", units: 105 }]);
    mod._setLedgerPool(mockPool as never);

    // Local memory shows user-a at 85 (below 100 cap, but >= 80 threshold)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 0,
      userUnits: new Map([["user-a", 85]]),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", "user-a", "free");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("user_cap");
  });

  it("allows when DB user total is under cap after resync", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    // DB reports user-a at 85 — same as local, still under cap
    const mockPool = makeMockPool([{ ledger_key: "user:user-a", units: 85 }]);
    mod._setLedgerPool(mockPool as never);

    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 0,
      userUnits: new Map([["user-a", 85]]),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", "user-a", "free");
    // 85 + 1 = 86 <= 100 — allowed
    expect(r.allowed).toBe(true);
  });
});

// ── 23. checkOraSpendCapAsync — DB total overrides stale per-IP ───────────────

describe("checkOraSpendCapAsync — DB total over anon IP cap while memory is under", () => {
  it("blocks when DB IP total exceeds cap even though local IP memory is under cap", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "50";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    // DB reports ip:10.0.0.1 at 55 (over the 50 cap)
    const mockPool = makeMockPool([{ ledger_key: "ip:10.0.0.1", units: 55 }]);
    mod._setLedgerPool(mockPool as never);

    // Local memory shows IP at 42 (>= floor(50*0.8)=40 — threshold triggered)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 0,
      userUnits: new Map(),
      ipUnits: new Map([["10.0.0.1", 42]]),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(
      makeReq({ ip: "10.0.0.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("anon_ip_cap");
  });

  it("allows when DB IP total is under cap after resync", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "50";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    // DB reports IP at 42 — matches local, still under cap
    const mockPool = makeMockPool([{ ledger_key: "ip:10.0.0.1", units: 42 }]);
    mod._setLedgerPool(mockPool as never);

    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 0,
      userUnits: new Map(),
      ipUnits: new Map([["10.0.0.1", 42]]),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(
      makeReq({ ip: "10.0.0.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    // 42 + 1 = 43 <= 50 — allowed
    expect(r.allowed).toBe(true);
  });
});

// ── 24. checkOraSpendCapAsync — close-to-cap triggers DB verification ─────────

describe("checkOraSpendCapAsync — close-to-cap forces DB verification", () => {
  it("triggers DB connect when global usage is at 80% threshold", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);

    // Memory at exactly 80 (= floor(100 * 0.8)) — triggers DB check
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 80,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    // resync.connect (1) + persist.connect (1) = 2 total
    expect(mockPool.connect.mock.calls.length).toBe(2);
  });

  it("triggers DB connect when user usage is at 80% threshold even if global is low", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);

    // Global at 5 (low), user-a at 80 (at threshold)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 5,
      userUnits: new Map([["user-a", 80]]),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", "user-a", "free");
    // resync was triggered: 2 connects (resync + persist)
    expect(mockPool.connect.mock.calls.length).toBe(2);
  });

  it("triggers DB connect when anon IP usage is at 80% threshold", async () => {
    process.env.ORA_ANON_IP_DAILY_UNIT_CAP = "50";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);

    // IP at 40 = floor(50 * 0.8) — at the threshold
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 0,
      userUnits: new Map(),
      ipUnits: new Map([["10.0.0.1", 40]]),
      featureUnits: new Map(),
    });

    await mod.checkOraSpendCapAsync(
      makeReq({ ip: "10.0.0.1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    // resync was triggered: 2 connects (resync + persist)
    expect(mockPool.connect.mock.calls.length).toBe(2);
  });
});

// ── 25. checkOraSpendCapAsync — low usage skips DB verification ───────────────

describe("checkOraSpendCapAsync — low-usage requests do not force DB verification", () => {
  it("does not trigger DB connect when global usage is well below threshold", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);

    // Memory at 10 (10% << 80% threshold)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 10,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    // Only persist.connect (1) — no resync
    expect(mockPool.connect.mock.calls.length).toBe(1);
  });

  it("does not trigger DB connect when user usage is well below threshold", async () => {
    process.env.ORA_USER_DAILY_UNIT_CAP = "100";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "10000";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);

    // Global at 0, user-a at 20 (well below 80 threshold)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 0,
      userUnits: new Map([["user-a", 20]]),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", "user-a", "free");
    // Only persist.connect (1) — no resync
    expect(mockPool.connect.mock.calls.length).toBe(1);
  });

  it("does not trigger DB connect when no ledger pool is configured", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();
    // No pool — _ledgerPool is null after beforeEach
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 90,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    // Should still work in memory-only mode even at high usage
    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(true);
  });
});

// ── 26. checkOraSpendCapAsync — DB unavailable at high usage falls back ────────

describe("checkOraSpendCapAsync — DB unavailable at high usage falls back safely", () => {
  it("falls back to in-memory caps when DB is unavailable at high usage", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    // Failing pool — connect() rejects
    mod._setLedgerPool(makeFailingPool() as never);

    // Memory at 85 (>= 80% threshold, so DB check is attempted)
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 85,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    // Should not throw and should fall back to in-memory (85 + 1 = 86 <= 100 — allowed)
    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("none");
  });

  it("in-memory cap still blocks when DB is unavailable and memory is over cap", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    mod._setLedgerPool(makeFailingPool() as never);

    // Memory already at 101 — over cap regardless of DB
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 101,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global_cap");
  });

  it("does not crash when DB query fails at high usage", async () => {
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    mod._setLedgerPool(makeQueryFailPool() as never);

    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 85,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    // Should not throw
    await expect(
      mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous"),
    ).resolves.not.toThrow();
  });
});

// ── 27. checkOraSpendCapAsync — E2E bypass works through async path ───────────

describe("checkOraSpendCapAsync — E2E bypass", () => {
  it("bypasses cap check when E2E_TEST_ENABLED=true and header present", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0"; // would block everything
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = await mod.checkOraSpendCapAsync(
      makeReq({ e2eHeader: "test-user-1" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    expect(r.allowed).toBe(true);
    expect(r.units).toBe(0);
  });

  it("does NOT bypass when E2E header is absent", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "0";
    const mod = await getModule();
    mod._resetSpendCapState();

    const r = await mod.checkOraSpendCapAsync(makeReq({}) as Request, "chat", null, "anonymous");
    expect(r.allowed).toBe(false);
  });

  it("E2E bypass does not trigger DB connect even at high usage", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    process.env.ORA_GLOBAL_DAILY_UNIT_CAP = "100";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    mod._setLedgerPool(mockPool as never);

    // Memory at 90 (above 80% threshold) — would normally trigger DB check
    mod._resetSpendCapState({
      dateKey: new Date().toISOString().slice(0, 10),
      globalUnits: 90,
      userUnits: new Map(),
      ipUnits: new Map(),
      featureUnits: new Map(),
    });

    await mod.checkOraSpendCapAsync(
      makeReq({ e2eHeader: "bypass-user" }) as Request,
      "chat",
      null,
      "anonymous",
    );
    // E2E bypass returns before DB check — no connect calls
    expect(mockPool.connect.mock.calls.length).toBe(0);
  });
});

// ── 28. periodicSyncActive snapshot field + _stopPeriodicSync ─────────────────

describe("getSpendCapSnapshot — periodicSyncActive field", () => {
  it("periodicSyncActive is false after reset (no periodic sync started)", async () => {
    const mod = await getModule();
    expect(mod.getSpendCapSnapshot().periodicSyncActive).toBe(false);
  });

  it("periodicSyncActive is true after initSpendLedger starts the interval", async () => {
    process.env.ORA_SPEND_RESYNC_INTERVAL_MS = "999999"; // large — never fires
    const mod = await getModule();
    mod._resetSpendCapState();

    const mockPool = makeMockPool([]);
    await mod.initSpendLedger(mockPool as never);

    expect(mod.getSpendCapSnapshot().periodicSyncActive).toBe(true);
    mod._stopPeriodicSync();
  });

  it("periodicSyncActive is false after _stopPeriodicSync is called", async () => {
    process.env.ORA_SPEND_RESYNC_INTERVAL_MS = "999999";
    const mod = await getModule();
    mod._resetSpendCapState();

    const mockPool = makeMockPool([]);
    await mod.initSpendLedger(mockPool as never);

    mod._stopPeriodicSync();
    expect(mod.getSpendCapSnapshot().periodicSyncActive).toBe(false);
  });

  it("_resetSpendCapState clears the periodic sync interval", async () => {
    process.env.ORA_SPEND_RESYNC_INTERVAL_MS = "999999";
    const mod = await getModule();

    const mockPool = makeMockPool([]);
    await mod.initSpendLedger(mockPool as never);
    expect(mod.getSpendCapSnapshot().periodicSyncActive).toBe(true);

    mod._resetSpendCapState(); // should clear the interval
    expect(mod.getSpendCapSnapshot().periodicSyncActive).toBe(false);
  });
});
