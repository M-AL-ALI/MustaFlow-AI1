/**
 * Talk to Ora — live-voice MINUTE-BUDGET route tests.
 *
 * These exercise the realtime route's budget wiring with the metering service
 * (ora-realtime-usage) MOCKED, so the focus is purely on how the route maps
 * service results to HTTP:
 *   - POST /session: over_limit -> 429, concurrent -> 409, DB throw -> 503
 *     fail-closed, ok -> mint + budget fields in the body, mint failure releases
 *     the reservation (endRealtimeSession with duration 0).
 *   - POST /heartbeat + POST /end: idempotent ticks, ownership/validation, and
 *     fail-closed 503 (always with ended:true so the client tears down).
 *   - GET /diagnostics: surfaces the per-plan budget (used/remaining/limit/
 *     window/reset) and STILL never leaks the model or raw provider voice id.
 *
 * A second describe block asserts web + mobile source PARITY for the live-voice
 * budget UI and the privacy-safe timing diagnostics (no raw audio/transcript).
 *
 * The companion realtime-session.test.ts covers mint config / isolation / voice
 * resolution against the real service; the metering service's own arithmetic is
 * covered by lib/public-ai/__tests__/ora-realtime-usage.test.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// ─── Paths ──────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const MUSTAFLOW_SRC_DIR = join(REPO_ROOT, "artifacts", "mustaflow", "src");
const ORA_MOBILE_DIR = join(REPO_ROOT, "artifacts", "ora-mobile");

function readMustaflow(relativePath: string): string {
  return readFileSync(join(MUSTAFLOW_SRC_DIR, relativePath), "utf-8");
}

function readOraMobile(relativePath: string): string {
  return readFileSync(join(ORA_MOBILE_DIR, relativePath), "utf-8");
}

// ─── Hoisted metering mock state ──────────────────────────────────────────────

const metering = vi.hoisted(() => ({
  startRealtimeSession: vi.fn(),
  heartbeatRealtimeSession: vi.fn(),
  endRealtimeSession: vi.fn(),
  getRealtimeUsage: vi.fn(),
}));

// ─── Mocks (hoisted before router import) ─────────────────────────────────────

vi.mock("../../../lib/rateLimit", () => ({
  oraRealtimeSessionLimiter: (_: unknown, __: unknown, next: () => void) => next(),
  oraRealtimeSessionTickLimiter: (_: unknown, __: unknown, next: () => void) => next(),
}));

vi.mock("../../../lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock("../../../lib/public-ai/authed-user", () => ({
  resolveAuthedOraUser: vi.fn(async () => null),
}));

vi.mock("../../../lib/public-ai/ora-spend-cap", () => ({
  checkOraSpendCapAsync: vi.fn(async () => ({
    allowed: true,
    limitType: "daily_spend_cap" as const,
    reason: "none",
    resetAt: "2026-06-27T00:00:00.000Z",
    retryAfter: 0,
    upgradeAvailable: false,
    message: "",
  })),
}));

vi.mock("../chat", () => ({
  buildSystemPrompt: vi.fn(() => "ORA SYSTEM PROMPT"),
  buildProfileContext: vi.fn(async () => ""),
  buildMemoryContext: vi.fn(async () => ({ text: "", used: [] })),
}));

// The metering service is mocked here; the route is the unit under test. Keep the
// real per-tier allowance + heartbeat cadence so /diagnostics + /session report
// truthful budget numbers, but stub the stateful DB-backed functions.
vi.mock("../../../lib/public-ai/ora-realtime-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/public-ai/ora-realtime-usage")>();
  return {
    ...actual,
    startRealtimeSession: metering.startRealtimeSession,
    heartbeatRealtimeSession: metering.heartbeatRealtimeSession,
    endRealtimeSession: metering.endRealtimeSession,
    getRealtimeUsage: metering.getRealtimeUsage,
  };
});

// ─── Imports after mocks ──────────────────────────────────────────────────────

import realtimeRouter from "../realtime";
import { createSession } from "../../../lib/public-ai/session";
import { resolveAuthedOraUser } from "../../../lib/public-ai/authed-user";
import { REALTIME_HEARTBEAT_INTERVAL_SECONDS } from "../../../lib/public-ai/ora-realtime-usage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", realtimeRouter);
  return app;
}

function freshCookie(): string {
  const { token } = createSession();
  return `ora-session=${token}`;
}

function mintOk(value = "ek_test_secret_value", expiresAt = 1900000000) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ value, expires_at: expiresAt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.ORA_SESSION_SECRET = "test-realtime-secret";
  process.env.OPENAI_API_KEY = "sk-test-key";
  delete process.env.ORA_DISABLED;
  delete process.env.ORA_REALTIME_DISABLED;
  delete process.env.ORA_REALTIME_ENABLED;
  delete process.env.ORA_REALTIME_MODEL;
  delete process.env.ORA_REALTIME_VOICE;

  vi.mocked(resolveAuthedOraUser).mockResolvedValue(null);
  metering.startRealtimeSession.mockReset();
  metering.heartbeatRealtimeSession.mockReset();
  metering.endRealtimeSession.mockReset();
  metering.getRealtimeUsage.mockReset();

  fetchMock = mintOk();
  vi.stubGlobal("fetch", fetchMock);
});

// ─── 1. POST /session — budget reservation ────────────────────────────────────

describe("Talk to Ora realtime — /session minute-budget reservation", () => {
  it("ok: mints and returns the reserved budget fields + heartbeat cadence", async () => {
    metering.startRealtimeSession.mockResolvedValue({
      status: "ok",
      sessionId: "11111111-1111-4111-8111-111111111111",
      maxDurationSeconds: 300,
      remainingSeconds: 1200,
      limitSeconds: 1200,
      windowHours: 5,
      resetsAt: null,
    });

    const res = await request(makeApp())
      .post("/api/public-ai/realtime/session")
      .set("Cookie", freshCookie())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.realtimeSessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(res.body.maxDurationSeconds).toBe(300);
    expect(res.body.remainingSeconds).toBe(1200);
    expect(res.body.limitSeconds).toBe(1200);
    expect(res.body.heartbeatIntervalSeconds).toBe(REALTIME_HEARTBEAT_INTERVAL_SECONDS);
    // The ephemeral client secret is returned; the real key never is.
    expect(res.body.value).toBe("ek_test_secret_value");
    expect(JSON.stringify(res.body)).not.toContain("sk-test-key");
    // The mint response carries the product-safe voice preset + label (the UI
    // surface); the raw provider voice id is never returned. (`model` is internal
    // WebRTC transport data the client needs and is hidden only in the UI.)
    expect(res.body.voicePreset).toBe("marine");
    expect(res.body.voiceLabel).toBe("Marine");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metering.startRealtimeSession).toHaveBeenCalledTimes(1);
  });

  it("over_limit: returns 429 with the realtime_voice_minutes budget shape", async () => {
    metering.startRealtimeSession.mockResolvedValue({
      status: "over_limit",
      remainingSeconds: 0,
      limitSeconds: 1200,
      resetsAt: "2026-06-28T05:00:00.000Z",
    });

    const res = await request(makeApp())
      .post("/api/public-ai/realtime/session")
      .set("Cookie", freshCookie())
      .send({});

    expect(res.status).toBe(429);
    expect(res.body.limitType).toBe("realtime_voice_minutes");
    expect(res.body.remainingSeconds).toBe(0);
    expect(res.body.limitSeconds).toBe(1200);
    // Service resetsAt is surfaced to the client as resetAt.
    expect(res.body.resetAt).toBe("2026-06-28T05:00:00.000Z");
    expect(res.body.upgradeAvailable).toBe(true);
    // Blocked before minting — no upstream token request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("concurrent: returns 409 realtime_voice_concurrent without minting", async () => {
    metering.startRealtimeSession.mockResolvedValue({
      status: "concurrent",
      remainingSeconds: 600,
      limitSeconds: 1200,
      resetsAt: "2026-06-28T05:00:00.000Z",
    });

    const res = await request(makeApp())
      .post("/api/public-ai/realtime/session")
      .set("Cookie", freshCookie())
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.limitType).toBe("realtime_voice_concurrent");
    expect(res.body.remainingSeconds).toBe(600);
    expect(res.body.limitSeconds).toBe(1200);
    expect(res.body.resetAt).toBe("2026-06-28T05:00:00.000Z");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fail-closed: a metering DB error returns 503 and never mints", async () => {
    metering.startRealtimeSession.mockRejectedValue(new Error("db down"));

    const res = await request(makeApp())
      .post("/api/public-ai/realtime/session")
      .set("Cookie", freshCookie())
      .send({});

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the reservation (ends with duration 0) when the upstream mint fails", async () => {
    metering.startRealtimeSession.mockResolvedValue({
      status: "ok",
      sessionId: "22222222-2222-4222-8222-222222222222",
      maxDurationSeconds: 300,
      remainingSeconds: 1200,
      limitSeconds: 1200,
      windowHours: 5,
      resetsAt: null,
    });
    metering.endRealtimeSession.mockResolvedValue({ status: "ended" });
    fetchMock = vi.fn(async () => new Response("upstream boom", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(makeApp())
      .post("/api/public-ai/realtime/session")
      .set("Cookie", freshCookie())
      .send({});

    expect(res.status).toBe(502);
    expect(metering.endRealtimeSession).toHaveBeenCalledTimes(1);
    const [sessionId, , , duration] = metering.endRealtimeSession.mock.calls[0];
    expect(sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(duration).toBe(0);
  });
});

// ─── 2. POST /heartbeat ───────────────────────────────────────────────────────

describe("Talk to Ora realtime — /heartbeat", () => {
  function postHeartbeat(body: Record<string, unknown>, cookie = freshCookie()) {
    return request(makeApp())
      .post("/api/public-ai/realtime/heartbeat")
      .set("Cookie", cookie)
      .send(body);
  }

  it("200: an active tick returns the live budget snapshot, ended=false", async () => {
    metering.heartbeatRealtimeSession.mockResolvedValue({
      status: "active",
      remainingSeconds: 1100,
      chargedSeconds: 100,
      limitSeconds: 1200,
      resetsAt: "2026-06-28T05:00:00.000Z",
      ended: false,
    });

    const res = await postHeartbeat({ realtimeSessionId: "33333333-3333-4333-8333-333333333333" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.ended).toBe(false);
    expect(res.body.remainingSeconds).toBe(1100);
    expect(res.body.limitSeconds).toBe(1200);
    expect(res.body.resetsAt).toBe("2026-06-28T05:00:00.000Z");
  });

  it("200 + ended=true once the per-session cap is reached", async () => {
    metering.heartbeatRealtimeSession.mockResolvedValue({
      status: "ended",
      remainingSeconds: 900,
      chargedSeconds: 300,
      limitSeconds: 1200,
      resetsAt: "2026-06-28T05:00:00.000Z",
      ended: true,
    });

    const res = await postHeartbeat({ realtimeSessionId: "44444444-4444-4444-8444-444444444444" });
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(true);
  });

  it("401 with ended:true when no session cookie is present", async () => {
    const res = await request(makeApp())
      .post("/api/public-ai/realtime/heartbeat")
      .send({ realtimeSessionId: "55555555-5555-4555-8555-555555555555" });
    expect(res.status).toBe(401);
    expect(res.body.ended).toBe(true);
    expect(metering.heartbeatRealtimeSession).not.toHaveBeenCalled();
  });

  it("400 when the session id is missing/invalid, without touching metering", async () => {
    const res = await postHeartbeat({});
    expect(res.status).toBe(400);
    expect(metering.heartbeatRealtimeSession).not.toHaveBeenCalled();
  });

  it("404 with ended:true when the session is unknown / not owned", async () => {
    metering.heartbeatRealtimeSession.mockResolvedValue({ status: "not_found" });
    const res = await postHeartbeat({ realtimeSessionId: "66666666-6666-4666-8666-666666666666" });
    expect(res.status).toBe(404);
    expect(res.body.ended).toBe(true);
  });

  it("503 with ended:true when metering throws (fail-closed)", async () => {
    metering.heartbeatRealtimeSession.mockRejectedValue(new Error("db down"));
    const res = await postHeartbeat({ realtimeSessionId: "77777777-7777-4777-8777-777777777777" });
    expect(res.status).toBe(503);
    expect(res.body.ended).toBe(true);
  });
});

// ─── 3. POST /end ─────────────────────────────────────────────────────────────

describe("Talk to Ora realtime — /end", () => {
  function postEnd(body: Record<string, unknown>, cookie = freshCookie()) {
    return request(makeApp()).post("/api/public-ai/realtime/end").set("Cookie", cookie).send(body);
  }

  it("200: finalizes and returns ended:true", async () => {
    metering.endRealtimeSession.mockResolvedValue({
      status: "ended",
      remainingSeconds: 1150,
      chargedSeconds: 50,
      limitSeconds: 1200,
      resetsAt: "2026-06-28T05:00:00.000Z",
      ended: true,
    });

    const res = await postEnd({
      realtimeSessionId: "88888888-8888-4888-8888-888888888888",
      durationSeconds: 50,
    });
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(true);
    expect(res.body.remainingSeconds).toBe(1150);
  });

  it("200 idempotent: ending an unknown/already-ended session still resolves ended:true", async () => {
    metering.endRealtimeSession.mockResolvedValue({ status: "not_found" });
    const res = await postEnd({ realtimeSessionId: "99999999-9999-4999-8999-999999999999" });
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(true);
  });

  it("401 when no session cookie is present", async () => {
    const res = await request(makeApp())
      .post("/api/public-ai/realtime/end")
      .send({ realtimeSessionId: "10101010-1010-4010-8010-101010101010" });
    expect(res.status).toBe(401);
    expect(metering.endRealtimeSession).not.toHaveBeenCalled();
  });

  it("503 when metering throws (fail-closed)", async () => {
    metering.endRealtimeSession.mockRejectedValue(new Error("db down"));
    const res = await postEnd({ realtimeSessionId: "12121212-1212-4212-8212-121212121212" });
    expect(res.status).toBe(503);
  });
});

// ─── 4. GET /diagnostics — budget surfaced, provider still hidden ──────────────

describe("Talk to Ora realtime — /diagnostics budget fields", () => {
  it("surfaces the per-plan budget (used/remaining/limit/window/reset) with no provider leak", async () => {
    metering.getRealtimeUsage.mockResolvedValue({
      usedSeconds: 200,
      limitSeconds: 1200,
      remainingSeconds: 1000,
      windowHours: 5,
      windowStart: "2026-06-28T00:00:00.000Z",
      resetsAt: "2026-06-28T05:00:00.000Z",
    });

    const res = await request(makeApp())
      .get("/api/public-ai/realtime/diagnostics")
      .set("Cookie", freshCookie());

    expect(res.status).toBe(200);
    expect(res.body.usedSeconds).toBe(200);
    expect(res.body.remainingSeconds).toBe(1000);
    expect(res.body.limitSeconds).toBe(1200);
    expect(res.body.windowHours).toBe(5);
    expect(res.body.resetsAt).toBe("2026-06-28T05:00:00.000Z");
    // Budget visibility must not regress the provider-hiding contract.
    expect(res.body.model).toBeUndefined();
    expect(res.body.defaultVoice).toBeUndefined();
  });
});

// ─── 5. Web + mobile source parity (budget UI + privacy-safe timing diag) ─────

describe("Talk to Ora realtime — web/mobile budget + timing-diagnostics parity", () => {
  const webHook = () => readMustaflow(join("hooks", "use-ora-realtime-voice.ts"));
  const webSettings = () => readMustaflow(join("pages", "ora-settings.tsx"));
  const mobileHook = () => readOraMobile(join("hooks", "useOraRealtimeVoiceNative.ts"));
  const mobileApi = () => readOraMobile(join("lib", "api.ts"));
  const mobileSettings = () => readOraMobile(join("app", "(home)", "settings.tsx"));
  const mobileHome = () => readOraMobile(join("app", "(home)", "index.tsx"));

  it("both clients call the same heartbeat + end endpoints with sessionId + duration", () => {
    // The web hook inlines the URLs; mobile centralizes them in lib/api.ts.
    for (const src of [webHook(), mobileApi()]) {
      expect(src).toContain("/api/public-ai/realtime/heartbeat");
      expect(src).toContain("/api/public-ai/realtime/end");
    }
    for (const src of [webHook(), mobileHook()]) {
      expect(src).toContain("realtimeSessionId");
      expect(src).toContain("durationSeconds");
    }
  });

  it("both settings surfaces show the remaining voice time, reset, and Marine/Mustafa presets", () => {
    for (const src of [webSettings(), mobileSettings()]) {
      expect(src).toContain("Voice time left");
      expect(src).toContain("Refreshes");
      expect(src).toContain("remainingSeconds");
      expect(src).toContain("limitSeconds");
      expect(src).toContain("resetsAt");
      expect(src).toContain("voicePreset");
    }
  });

  it("neither settings surface leaks the underlying model or raw provider voice id", () => {
    for (const src of [webSettings(), mobileSettings()]) {
      expect(src).not.toContain("cedar");
      expect(src).not.toMatch(/gpt-[a-z0-9]/i);
    }
  });

  it("both surfaces show the same graceful over-limit message", () => {
    expect(webHook()).toContain("You've used all your live voice time");
    expect(mobileHome()).toContain("You've used all your live voice time");
  });

  it("the web hook maps the 429 minute-budget + 409 concurrency limit types", () => {
    const src = webHook();
    expect(src).toContain("realtime_voice_minutes");
    expect(src).toContain("realtime_voice_concurrent");
  });

  it("timing diagnostics are explicitly privacy-safe (no raw audio or transcript)", () => {
    for (const src of [webHook(), mobileHook()]) {
      expect(src).toContain("logVoiceDiag");
      expect(src).toMatch(/NEVER raw audio or full transcript/i);
    }
  });
});
