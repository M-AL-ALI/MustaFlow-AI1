/**
 * Unit tests for lib/rateLimit.ts — the in-memory rate limiter + AI semaphore.
 *
 * Covers:
 *   - createLimiter (via the exported createLimiterForDomainVerify factory):
 *     sliding-window counting, X-RateLimit headers, hard 429 over the cap, and
 *     window reset after the TTL elapses.
 *   - aiBuilderLimiter / oraLimiter: concurrency cap (slots proceed), FIFO
 *     queueing past capacity, queue-full hard 429, slot drain on finish, and
 *     queue-wait timeout 429.
 *   - Builder vs Ora semaphore isolation (separate keys → no contention).
 *
 * State is module-level and keyed by client IP, so every test uses a unique IP
 * to stay isolated without needing to reset internals.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Request, Response, NextFunction } from "express";
import {
  admissionClientIp,
  aiBuilderLimiter,
  oraLimiter,
  createLimiterForDomainVerify,
} from "../rateLimit";
import { logger } from "../logger";

type FakeReq = Request & {
  abort: () => void;
};

function makeReq(ip: string): FakeReq {
  const ee = new EventEmitter();
  const req = ee as unknown as FakeReq;
  req.headers = {
    "x-forwarded-for": "198.51.100.200, 198.51.100.201",
    forwarded: "for=198.51.100.202;proto=https",
    "cf-connecting-ip": "198.51.100.203",
    "x-real-ip": "198.51.100.204",
  };
  req.socket = { remoteAddress: ip } as Request["socket"];
  req.abort = () => ee.emit("aborted");
  return req;
}

type FakeRes = Response & {
  statusCode?: number;
  jsonBody?: unknown;
  outHeaders: Record<string, unknown>;
  finish: () => void;
  close: () => void;
};

function makeRes(): FakeRes {
  const ee = new EventEmitter();
  const res = ee as unknown as FakeRes;
  res.outHeaders = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).headersSent = false;
  res.setHeader = vi.fn((k: string, v: unknown) => {
    res.outHeaders[k] = v;
    return res;
  }) as unknown as FakeRes["setHeader"];
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  }) as unknown as FakeRes["status"];
  res.json = vi.fn((b: unknown) => {
    res.jsonBody = b;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).headersSent = true;
    return res;
  }) as unknown as FakeRes["json"];
  // Helper to simulate the connection finishing (drains the semaphore).
  res.finish = () => ee.emit("finish");
  res.close = () => ee.emit("close");
  return res;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("admission network identity", () => {
  it("uses the immediate socket and ignores every forwarding-header identity", () => {
    expect(admissionClientIp(makeReq("10.0.0.42"))).toBe("10.0.0.42");
  });

  it("uses one non-header fallback when the socket identity is missing", () => {
    const req = makeReq("10.0.0.43");
    req.socket = { remoteAddress: undefined } as Request["socket"];
    expect(admissionClientIp(req)).toBe("unknown");
  });
});

// ─── createLimiter (sliding window) ──────────────────────────────────────────
describe("createLimiter sliding window", () => {
  it("allows requests up to the cap and sets X-RateLimit headers", () => {
    const limiter = createLimiterForDomainVerify({
      windowMs: 60_000,
      max: 3,
      keyPrefix: "test_allow",
    });
    const ip = "1.1.1.1";
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      const next = vi.fn();
      limiter(makeReq(ip), res, next as NextFunction);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.outHeaders["X-RateLimit-Limit"]).toBe(3);
    }
  });

  it("returns a 429 with retryAfter once the cap is exceeded", () => {
    const limiter = createLimiterForDomainVerify({
      windowMs: 60_000,
      max: 2,
      keyPrefix: "test_cap",
      message: "slow down",
    });
    const ip = "2.2.2.2";
    for (let i = 0; i < 2; i++) limiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);

    const res = makeRes();
    const next = vi.fn();
    limiter(makeReq(ip), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({ error: "slow down" });
    expect((res.jsonBody as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  it("resets the counter after the window elapses", () => {
    vi.useFakeTimers();
    const limiter = createLimiterForDomainVerify({
      windowMs: 1_000,
      max: 1,
      keyPrefix: "test_reset",
    });
    const ip = "3.3.3.3";

    limiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);
    const blocked = makeRes();
    limiter(makeReq(ip), blocked, vi.fn() as NextFunction);
    expect(blocked.statusCode).toBe(429);

    vi.advanceTimersByTime(1_001);
    const afterReset = makeRes();
    const next = vi.fn();
    limiter(makeReq(ip), afterReset, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(afterReset.statusCode).toBeUndefined();
  });

  it("tracks each IP independently", () => {
    const limiter = createLimiterForDomainVerify({
      windowMs: 60_000,
      max: 1,
      keyPrefix: "test_perip",
    });
    limiter(makeReq("4.4.4.4"), makeRes(), vi.fn() as NextFunction);
    const blockedSame = makeRes();
    limiter(makeReq("4.4.4.4"), blockedSame, vi.fn() as NextFunction);
    expect(blockedSame.statusCode).toBe(429);

    const otherIp = makeRes();
    const next = vi.fn();
    limiter(makeReq("5.5.5.5"), otherIp, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── aiBuilderLimiter (semaphore + queue) ────────────────────────────────────
describe("aiBuilderLimiter semaphore + queue", () => {
  it("admits up to MAX_CONCURRENT (3) requests immediately", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      const next = vi.fn();
      aiBuilderLimiter(makeReq(ip), res, next as NextFunction);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.outHeaders["X-AI-Active"]).toBe(i);
    }
  });

  it("queues requests past capacity without calling next", () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 3; i++) aiBuilderLimiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);

    const res = makeRes();
    const next = vi.fn();
    aiBuilderLimiter(makeReq(ip), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.outHeaders["X-Queue-Position"]).toBe(1);
  });

  it("hard-429s when the pending queue is full (3 active + 5 queued)", () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 3; i++) aiBuilderLimiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);
    for (let i = 0; i < 5; i++) aiBuilderLimiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);

    const res = makeRes();
    const next = vi.fn();
    aiBuilderLimiter(makeReq(ip), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({ retryAfter: 60 });
  });

  it("drains the next queued request when an active slot finishes", () => {
    const logSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const ip = "10.0.0.4";
    const active: FakeRes[] = [];
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      aiBuilderLimiter(makeReq(ip), res, vi.fn() as NextFunction);
      active.push(res);
    }
    const queuedRes = makeRes();
    const queuedNext = vi.fn();
    aiBuilderLimiter(makeReq(ip), queuedRes, queuedNext as NextFunction);
    expect(queuedNext).not.toHaveBeenCalled();

    // One active request completes → the queued request is drained.
    active[0].finish();
    expect(queuedNext).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "release", reason: "finish" }),
      "AI builder semaphore event",
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "queue-drain" }),
      "AI builder semaphore event",
    );
  });

  it("releases an aborted active request and drains the next queued request", () => {
    const logSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const ip = "10.0.0.6";
    const active: FakeRes[] = [];
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      aiBuilderLimiter(makeReq(ip), res, vi.fn() as NextFunction);
      active.push(res);
    }

    const queuedRes = makeRes();
    const queuedNext = vi.fn();
    aiBuilderLimiter(makeReq(ip), queuedRes, queuedNext as NextFunction);
    expect(queuedNext).not.toHaveBeenCalled();

    active[0].close();

    expect(queuedNext).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "release", reason: "close" }),
      "AI builder semaphore event",
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "queue-drain" }),
      "AI builder semaphore event",
    );
  });

  it("removes aborted or closed queued requests and clears their timers", () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "info").mockImplementation(() => undefined);

    for (const signal of ["abort", "close"] as const) {
      const ip = signal === "abort" ? "10.0.0.7" : "10.0.0.8";
      const active: FakeRes[] = [];
      for (let i = 0; i < 3; i++) {
        const res = makeRes();
        aiBuilderLimiter(makeReq(ip), res, vi.fn() as NextFunction);
        active.push(res);
      }

      const queuedReq = makeReq(ip);
      const queuedRes = makeRes();
      const queuedNext = vi.fn();
      const timersBeforeQueue = vi.getTimerCount();
      aiBuilderLimiter(queuedReq, queuedRes, queuedNext as NextFunction);
      expect(vi.getTimerCount()).toBe(timersBeforeQueue + 1);

      if (signal === "abort") queuedReq.abort();
      else queuedRes.close();

      expect(vi.getTimerCount()).toBe(timersBeforeQueue);
      active[0].finish();
      expect(queuedNext).not.toHaveBeenCalled();

      const replacementNext = vi.fn();
      aiBuilderLimiter(makeReq(ip), makeRes(), replacementNext as NextFunction);
      expect(replacementNext).toHaveBeenCalledTimes(1);
    }
  });

  it("releases exactly once when finish is followed by close", () => {
    const logSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const ip = "10.0.0.9";
    const active: FakeRes[] = [];
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      aiBuilderLimiter(makeReq(ip), res, vi.fn() as NextFunction);
      active.push(res);
    }

    const firstQueuedNext = vi.fn();
    const secondQueuedNext = vi.fn();
    aiBuilderLimiter(makeReq(ip), makeRes(), firstQueuedNext as NextFunction);
    aiBuilderLimiter(makeReq(ip), makeRes(), secondQueuedNext as NextFunction);

    active[0].finish();
    active[0].close();

    expect(firstQueuedNext).toHaveBeenCalledTimes(1);
    expect(secondQueuedNext).not.toHaveBeenCalled();
    const releaseLogs = logSpy.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "release",
    );
    expect(releaseLogs).toHaveLength(1);
  });

  it("429s a queued request after the queue-wait timeout elapses", () => {
    vi.useFakeTimers();
    const ip = "10.0.0.5";
    for (let i = 0; i < 3; i++) aiBuilderLimiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);

    const res = makeRes();
    const next = vi.fn();
    aiBuilderLimiter(makeReq(ip), res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_001);
    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── oraLimiter (separate, tighter semaphore) ────────────────────────────────
describe("oraLimiter", () => {
  it("admits MAX_CONCURRENT (2), then queues, then hard-429s when full", () => {
    const ip = "20.0.0.1";
    for (let i = 0; i < 2; i++) {
      const next = vi.fn();
      oraLimiter(makeReq(ip), makeRes(), next as NextFunction);
      expect(next).toHaveBeenCalledTimes(1);
    }
    // 3 queued slots
    for (let i = 0; i < 3; i++) {
      const next = vi.fn();
      oraLimiter(makeReq(ip), makeRes(), next as NextFunction);
      expect(next).not.toHaveBeenCalled();
    }
    // queue full → 429
    const res = makeRes();
    oraLimiter(makeReq(ip), res, vi.fn() as NextFunction);
    expect(res.statusCode).toBe(429);
  });

  it("is isolated from the Builder semaphore (no cross-contention)", () => {
    const ip = "20.0.0.2";
    // Saturate Ora (2 active + 3 queued) for this IP.
    for (let i = 0; i < 5; i++) oraLimiter(makeReq(ip), makeRes(), vi.fn() as NextFunction);

    // Builder should still admit this IP — different semaphore key.
    const res = makeRes();
    const next = vi.fn();
    aiBuilderLimiter(makeReq(ip), res, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
