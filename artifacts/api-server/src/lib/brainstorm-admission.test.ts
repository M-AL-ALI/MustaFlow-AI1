import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import requestHttp from "supertest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  clientIp: vi.fn(),
  reserve: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@clerk/express", () => ({ getAuth: mocks.getAuth }));
vi.mock("./rateLimit", () => ({ admissionClientIp: mocks.clientIp }));
vi.mock("./redisClient", () => ({ reserveDualWindowAdmission: mocks.reserve }));
vi.mock("./logger", () => ({ logger: { warn: mocks.warn } }));

import {
  attachOptionalClerkUser,
  brainstormAdmissionConfig,
  brainstormAdmissionLimiter,
  brainstormAdmissionWeight,
} from "./brainstorm-admission";

const allowed = {
  allowed: true,
  blockedWindow: null,
  hourCount: 1,
  dayCount: 1,
  hourResetAtMs: 1_800_003_600_000,
  dayResetAtMs: 1_800_057_600_000,
  serverNowMs: 1_800_000_001_000,
};

function request(path: string, userId?: string): Request {
  return { path, userId } as Request;
}

function response() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status: vi.fn((status: number) => {
      state.status = status;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      state.body = body;
      return res;
    }),
  } as unknown as Response;
  return { res, state };
}

async function runLimiter(req: Request) {
  const { res, state } = response();
  const next = vi.fn();
  brainstormAdmissionLimiter(req, res, next as unknown as NextFunction);
  await vi.waitFor(() => {
    expect(next.mock.calls.length + (res.json as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      1,
    );
  });
  return { res, state, next };
}

describe("brainstorm admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientIp.mockReturnValue("socket-identity");
    mocks.reserve.mockResolvedValue(allowed);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the approved configurable defaults and resolve weight", () => {
    expect(brainstormAdmissionConfig()).toEqual({
      accountHourly: 60,
      accountDaily: 200,
      authenticatedIpHourly: 120,
      authenticatedIpDaily: 400,
      anonymousIpHourly: 60,
      anonymousIpDaily: 200,
    });
    expect(brainstormAdmissionWeight(request("/brainstorm/chat"))).toBe(1);
    expect(brainstormAdmissionWeight(request("/brainstorm/resolve"))).toBe(2);
  });

  it("honors positive integer overrides and rejects invalid override values", () => {
    vi.stubEnv("BRAINSTORM_ACCOUNT_HOURLY_UNITS", "75");
    vi.stubEnv("BRAINSTORM_ACCOUNT_DAILY_UNITS", "oops");

    expect(brainstormAdmissionConfig()).toMatchObject({ accountHourly: 75, accountDaily: 200 });
  });

  it("keeps public chat anonymous when no optional Clerk identity exists", () => {
    mocks.getAuth.mockReturnValue({ userId: null, sessionClaims: {} });
    const req = request("/brainstorm/chat");
    const next = vi.fn();

    attachOptionalClerkUser(req, {} as Response, next);

    expect(req.userId).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("attaches an optional authenticated identity without making public chat require auth", () => {
    mocks.getAuth.mockReturnValue({ userId: "account-one", sessionClaims: {} });
    const req = request("/brainstorm/chat");

    attachOptionalClerkUser(req, {} as Response, vi.fn());

    expect(req.userId).toBe("account-one");
  });

  it("reserves authenticated account capacity and the independent IP backstop", async () => {
    const { next } = await runLimiter(request("/brainstorm/chat", "account-one"));

    expect(next).toHaveBeenCalledOnce();
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    expect(mocks.reserve.mock.calls[0]?.[0]).toMatchObject({
      hourlyLimit: 60,
      dailyLimit: 200,
      weight: 1,
    });
    expect(mocks.reserve.mock.calls[1]?.[0]).toMatchObject({
      hourlyLimit: 120,
      dailyLimit: 400,
      weight: 1,
    });
    expect(mocks.reserve.mock.calls[0]?.[0].key).not.toBe(mocks.reserve.mock.calls[1]?.[0].key);
  });

  it("keeps account and IP identities independently scoped", async () => {
    mocks.clientIp.mockReturnValueOnce("ip-a").mockReturnValueOnce("ip-b");
    await runLimiter(request("/brainstorm/chat", "same-account"));
    await runLimiter(request("/brainstorm/chat", "same-account"));
    const firstAccountKey = mocks.reserve.mock.calls[0]?.[0].key;
    const secondAccountKey = mocks.reserve.mock.calls[2]?.[0].key;
    const firstIpKey = mocks.reserve.mock.calls[1]?.[0].key;
    const secondIpKey = mocks.reserve.mock.calls[3]?.[0].key;

    expect(firstAccountKey).toBe(secondAccountKey);
    expect(firstIpKey).not.toBe(secondIpKey);

    mocks.reserve.mockClear();
    mocks.clientIp.mockReturnValue("shared-ip");
    await runLimiter(request("/brainstorm/chat", "account-a"));
    await runLimiter(request("/brainstorm/chat", "account-b"));
    expect(mocks.reserve.mock.calls[0]?.[0].key).not.toBe(mocks.reserve.mock.calls[2]?.[0].key);
    expect(mocks.reserve.mock.calls[1]?.[0].key).toBe(mocks.reserve.mock.calls[3]?.[0].key);
  });

  it("uses only the stricter anonymous IP boundary for public chat", async () => {
    await runLimiter(request("/brainstorm/chat"));

    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.reserve.mock.calls[0]?.[0]).toMatchObject({
      hourlyLimit: 60,
      dailyLimit: 200,
      weight: 1,
    });
  });

  it.each(["hour", "day"] as const)(
    "returns a typed 429 with reset data for the %s cap",
    async (blockedWindow) => {
      mocks.reserve.mockResolvedValueOnce({
        ...allowed,
        allowed: false,
        blockedWindow,
      });

      const { state, next } = await runLimiter(request("/brainstorm/resolve", "account-one"));

      expect(next).not.toHaveBeenCalled();
      expect(state.status).toBe(429);
      expect(state.body).toMatchObject({
        code: "brainstorm_limit_reached",
        limitWindow: blockedWindow,
        retryAfter: blockedWindow === "hour" ? 3_599 : 57_599,
        resetAt: expect.any(String),
      });
      expect(mocks.reserve.mock.calls[0]?.[0].weight).toBe(2);
    },
  );

  it.each([
    ["missing bindings", new Error("Redis not configured")],
    ["transport", new TypeError("offline")],
    ["invalid response", new Error("Redis returned an invalid admission result")],
  ])("fails closed with typed 503 and zero downstream dispatch on %s", async (_name, error) => {
    mocks.reserve.mockRejectedValueOnce(error);

    const { state, next } = await runLimiter(request("/brainstorm/chat"));

    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(503);
    expect(state.body).toEqual({
      error:
        "Brainstorming is temporarily unavailable because usage checks could not complete. Please try again shortly.",
      code: "brainstorm_admission_unavailable",
      retryable: true,
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      { errorClass: error.constructor.name },
      "Brainstorm admission store unavailable",
    );
  });

  it("produces the typed hour, day, and store-down responses over real HTTP", async () => {
    const app = express();
    app.post("/brainstorm/chat", brainstormAdmissionLimiter, (_req, res) => {
      res.status(204).end();
    });

    mocks.reserve.mockResolvedValueOnce({ ...allowed, allowed: false, blockedWindow: "hour" });
    const hourly = await requestHttp(app).post("/brainstorm/chat");
    expect(hourly.status).toBe(429);
    expect(hourly.headers["content-type"]).toContain("application/json");
    expect(hourly.body).toMatchObject({
      code: "brainstorm_limit_reached",
      limitWindow: "hour",
      retryAfter: expect.any(Number),
      resetAt: expect.any(String),
    });

    mocks.reserve.mockResolvedValueOnce({ ...allowed, allowed: false, blockedWindow: "day" });
    const daily = await requestHttp(app).post("/brainstorm/chat");
    expect(daily.status).toBe(429);
    expect(daily.body).toMatchObject({ code: "brainstorm_limit_reached", limitWindow: "day" });

    mocks.reserve.mockRejectedValueOnce(new TypeError("offline"));
    const unavailable = await requestHttp(app).post("/brainstorm/chat");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      error:
        "Brainstorming is temporarily unavailable because usage checks could not complete. Please try again shortly.",
      code: "brainstorm_admission_unavailable",
      retryable: true,
    });
  });
});
