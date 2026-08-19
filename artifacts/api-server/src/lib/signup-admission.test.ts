import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  warn: vi.fn(),
  createProxyMiddleware: vi.fn((_options: unknown) => vi.fn()),
}));

vi.mock("./brainstorm-admission-store", () => ({
  reserveDualWindowAdmission: mocks.reserve,
}));

vi.mock("./logger", () => ({
  logger: { warn: mocks.warn },
}));

vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: mocks.createProxyMiddleware,
}));

import {
  SIGNUP_CREATE_WEIGHT,
  SIGNUP_FOLLOWUP_WEIGHT,
  classifyClerkSignupMutation,
  clerkSignupAdmissionLimiter,
  signupAdmissionConfig,
} from "./signup-admission";
import { clerkProxyMiddleware } from "../middlewares/clerkProxyMiddleware";

const allowed = {
  allowed: true,
  blockedWindow: null,
  hourCount: 3,
  dayCount: 3,
  hourResetAtMs: Date.parse("2026-08-19T13:00:00.000Z"),
  dayResetAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
  serverNowMs: Date.parse("2026-08-19T12:00:00.000Z"),
} as const;

function requestFor(method: string, originalUrl: string, remoteAddress = "203.0.113.40"): Request {
  return {
    method,
    originalUrl,
    socket: { remoteAddress },
    headers: {},
  } as unknown as Request;
}

async function runLimiter(req: Request): Promise<{
  next: ReturnType<typeof vi.fn>;
  status: number;
  body: unknown;
}> {
  const state: { status: number; body: unknown } = { status: 200, body: null };
  let settle!: () => void;
  const done = new Promise<void>((resolveDone) => {
    settle = resolveDone;
  });
  const next = vi.fn(() => settle());
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      settle();
      return this;
    },
  } as unknown as Response;

  clerkSignupAdmissionLimiter(req, res, next as unknown as NextFunction);
  await done;
  return { next, ...state };
}

describe("Clerk signup mutation admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLERK_SECRET_KEY", "configured-for-test");
    vi.stubEnv("SIGNUP_SOCKET_HOURLY_UNITS", "");
    vi.stubEnv("SIGNUP_SOCKET_DAILY_UNITS", "");
    mocks.reserve.mockResolvedValue(allowed);
  });

  it("pins the installed Clerk SDK signup mutation contract", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const requireFromWeb = createRequire(resolve(here, "../../../mustaflow/package.json"));
    const installedSource = readFileSync(requireFromWeb.resolve("@clerk/clerk-js"), "utf8");

    expect(installedSource).toContain('pathRoot="/client/sign_ups"');
    expect(installedSource).toContain('action:"prepare_verification"');
    expect(installedSource).toContain('action:"attempt_verification"');
  });

  it.each([
    ["POST", "/api/__clerk/v1/client/sign_ups", "create", SIGNUP_CREATE_WEIGHT],
    ["PATCH", "/api/__clerk/v1/client/sign_ups/sua_example", "update", SIGNUP_FOLLOWUP_WEIGHT],
    [
      "POST",
      "/api/__clerk/v1/client/sign_ups/sua_example/prepare_verification",
      "prepare_verification",
      SIGNUP_FOLLOWUP_WEIGHT,
    ],
    [
      "POST",
      "/api/__clerk/v1/client/sign_ups/sua_example/attempt_verification?code=ignored",
      "attempt_verification",
      SIGNUP_FOLLOWUP_WEIGHT,
    ],
  ] as const)("classifies %s %s", (method, url, stage, weight) => {
    expect(classifyClerkSignupMutation(method, url)).toEqual({ stage, weight });
  });

  it.each([
    ["GET", "/api/__clerk/v1/environment"],
    ["GET", "/api/__clerk/v1/client"],
    ["POST", "/api/__clerk/v1/client/sign_ins"],
    ["POST", "/api/__clerk/v1/client/sign_ups/sua_example/unknown_action"],
    ["POST", "/api/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js"],
  ])("does not guess a signup mutation for %s %s", (method, url) => {
    expect(classifyClerkSignupMutation(method, url)).toBeNull();
  });

  it("uses named defaults with positive integer overrides", () => {
    expect(signupAdmissionConfig()).toEqual({ socketHourly: 60, socketDaily: 200 });
    vi.stubEnv("SIGNUP_SOCKET_HOURLY_UNITS", "75");
    vi.stubEnv("SIGNUP_SOCKET_DAILY_UNITS", "oops");
    expect(signupAdmissionConfig()).toEqual({ socketHourly: 75, socketDaily: 200 });
  });

  it("reserves the weighted durable socket boundary before dispatch", async () => {
    const result = await runLimiter(
      requestFor("POST", "/api/__clerk/v1/client/sign_ups", "198.51.100.8"),
    );

    expect(result.next).toHaveBeenCalledOnce();
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.reserve.mock.calls[0]?.[0]).toMatchObject({
      hourlyLimit: 60,
      dailyLimit: 200,
      weight: 3,
    });
    const key = String(mocks.reserve.mock.calls[0]?.[0].key);
    expect(key).toMatch(/^signup-admission:v1:ip:[a-f0-9]{64}$/);
    expect(key).not.toContain("198.51.100.8");
  });

  it("keeps spoofed forwarding headers in the same accepted socket bucket", async () => {
    const first = requestFor("POST", "/api/__clerk/v1/client/sign_ups", "198.51.100.8");
    first.headers["x-forwarded-for"] = "192.0.2.10";
    const second = requestFor("POST", "/api/__clerk/v1/client/sign_ups", "198.51.100.8");
    second.headers["x-forwarded-for"] = "192.0.2.11";

    await runLimiter(first);
    await runLimiter(second);

    expect(mocks.reserve.mock.calls[0]?.[0].key).toBe(mocks.reserve.mock.calls[1]?.[0].key);
  });

  it.each(["hour", "day"] as const)("returns a typed %s-window denial", async (window) => {
    mocks.reserve.mockResolvedValueOnce({ ...allowed, allowed: false, blockedWindow: window });

    const result = await runLimiter(
      requestFor("POST", "/api/__clerk/v1/client/sign_ups/sua_example/attempt_verification"),
    );

    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({
      code: "signup_limit_reached",
      stage: "attempt_verification",
      limitWindow: window,
      retryAfter: expect.any(Number),
      resetAt: expect.any(String),
    });
  });

  it("fails closed with a typed store outcome and zero dispatch", async () => {
    mocks.reserve.mockRejectedValueOnce(new TypeError("offline"));

    const result = await runLimiter(
      requestFor("POST", "/api/__clerk/v1/client/sign_ups/sua_example/prepare_verification"),
    );

    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error:
        "Account creation is temporarily unavailable because usage checks could not complete. Please try again shortly.",
      code: "signup_admission_unavailable",
      stage: "prepare_verification",
      retryable: true,
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      { errorClass: "TypeError", stage: "prepare_verification" },
      "Signup admission store unavailable",
    );
  });

  it("does not debit ordinary proxy traffic or local disabled-proxy traffic", async () => {
    await runLimiter(requestFor("GET", "/api/__clerk/v1/environment"));
    vi.stubEnv("NODE_ENV", "test");
    await runLimiter(requestFor("POST", "/api/__clerk/v1/client/sign_ups"));

    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});

describe("Clerk proxy identity forwarding and mount order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLERK_SECRET_KEY", "configured-for-test");
  });

  it("forwards only the accepted socket identity to Clerk", () => {
    clerkProxyMiddleware();
    const options = mocks.createProxyMiddleware.mock.calls[0]?.[0] as {
      on: { proxyReq: (proxyReq: { setHeader: ReturnType<typeof vi.fn> }, req: Request) => void };
    };
    const setHeader = vi.fn();
    const req = requestFor("POST", "/api/__clerk/v1/client/sign_ups", "203.0.113.19");
    req.headers["x-forwarded-for"] = "192.0.2.90, 192.0.2.91";
    req.headers.host = "www.mustaflow.com";

    options.on.proxyReq({ setHeader }, req);

    expect(setHeader).toHaveBeenCalledWith("X-Forwarded-For", "203.0.113.19");
    expect(setHeader).not.toHaveBeenCalledWith(
      "X-Forwarded-For",
      expect.stringContaining("192.0.2"),
    );
  });

  it("mounts the broad and durable boundaries before the proxy dispatch", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const appSource = readFileSync(resolve(here, "../app.ts"), "utf8");
    expect(appSource).toMatch(
      /app\.use\(\s*CLERK_PROXY_PATH,\s*generalLimiter,\s*clerkSignupAdmissionLimiter,\s*clerkProxyMiddleware\(\),?\s*\);/,
    );
  });
});
