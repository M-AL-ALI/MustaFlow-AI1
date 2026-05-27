/**
 * Unit tests for R2 snapshot upload — Cache-Control headers and per-file retry logic.
 *
 * Tests:
 *  1. HTML files receive `no-cache` Cache-Control header
 *  2. Non-HTML files receive `public, max-age=31536000, immutable` Cache-Control header
 *  3. A file that fails on the first attempt but succeeds on the second is retried,
 *     the correct Cache-Control header is passed on retry, and allOk is true
 *  4. A file that fails all 4 attempts (1 initial + 3 retries) causes allOk to be false
 *  5. uploadSnapshotToR2 returns false (no crash) when R2 env vars are absent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── r2CacheControl is a pure helper — test it directly ───────────────────────

import { r2CacheControl } from "./cloudflare";

describe("r2CacheControl", () => {
  it("returns no-cache for .html paths", () => {
    expect(r2CacheControl("index.html")).toBe("no-cache");
    expect(r2CacheControl("pages/about.html")).toBe("no-cache");
    expect(r2CacheControl("/index.html")).toBe("no-cache");
  });

  it("returns immutable for non-HTML paths", () => {
    const immutable = "public, max-age=31536000, immutable";
    expect(r2CacheControl("app.js")).toBe(immutable);
    expect(r2CacheControl("styles/main.css")).toBe(immutable);
    expect(r2CacheControl("images/logo.png")).toBe(immutable);
    expect(r2CacheControl("font.woff2")).toBe(immutable);
    expect(r2CacheControl("data.json")).toBe(immutable);
  });
});

// ── uploadSnapshotToR2 — mock fetch to test retry + Cache-Control ─────────────

describe("uploadSnapshotToR2", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    process.env.CF_ACCOUNT_ID = "test-account";
    process.env.CF_R2_ACCESS_KEY_ID = "test-access-key";
    process.env.CF_R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.CF_R2_BUCKET = "test-bucket";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original env
    for (const key of [
      "CF_ACCOUNT_ID",
      "CF_R2_ACCESS_KEY_ID",
      "CF_R2_SECRET_ACCESS_KEY",
      "CF_R2_BUCKET",
    ]) {
      if (ORIG_ENV[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = ORIG_ENV[key];
      }
    }
  });

  it("returns false without crashing when R2 env vars are absent", async () => {
    delete process.env.CF_ACCOUNT_ID;
    delete process.env.CF_R2_ACCESS_KEY_ID;
    delete process.env.CF_R2_SECRET_ACCESS_KEY;

    // Re-import to pick up the env state (r2Enabled() reads process.env at call time)
    const { uploadSnapshotToR2 } = await import("./cloudflare");
    const result = await uploadSnapshotToR2(1, 1, [
      { path: "index.html", content: "<html></html>", mimeType: "text/html" },
    ]);
    expect(result).toBe(false);
  });

  it("passes correct Cache-Control per file type and retries a failing file", async () => {
    // Track calls: key → list of Cache-Control values seen per attempt
    const calls: Array<{ key: string; cacheControl: string | null }> = [];

    // Fail index.html on the first attempt, succeed on second.
    // Succeed app.js on the first attempt.
    let htmlAttempts = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const cacheControl = headers["cache-control"] ?? null;
        const urlStr = String(url);

        if (urlStr.includes("index.html")) {
          calls.push({ key: "index.html", cacheControl });
          htmlAttempts++;
          if (htmlAttempts === 1) {
            return { ok: false, status: 500 } as Response;
          }
          return { ok: true, status: 200 } as Response;
        }

        if (urlStr.includes("app.js")) {
          calls.push({ key: "app.js", cacheControl });
          return { ok: true, status: 200 } as Response;
        }

        return { ok: true, status: 200 } as Response;
      }),
    );

    const { uploadSnapshotToR2 } = await import("./cloudflare");

    const result = await uploadSnapshotToR2(1, 42, [
      { path: "index.html", content: "<html></html>", mimeType: "text/html" },
      { path: "app.js", content: "console.log(1)", mimeType: "application/javascript" },
    ]);

    // (a) allOk is true — all files eventually succeeded
    expect(result).toBe(true);

    // (b) retry was attempted for index.html — should have 2 calls
    const htmlCalls = calls.filter((c) => c.key === "index.html");
    expect(htmlCalls.length).toBeGreaterThanOrEqual(2);

    // (c) correct Cache-Control per file type on every attempt
    for (const call of htmlCalls) {
      expect(call.cacheControl).toBe("no-cache");
    }
    const jsCalls = calls.filter((c) => c.key === "app.js");
    expect(jsCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of jsCalls) {
      expect(call.cacheControl).toBe("public, max-age=31536000, immutable");
    }
  });

  it("returns false when all retries for a file are exhausted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }) as Response),
    );

    const { uploadSnapshotToR2 } = await import("./cloudflare");

    const result = await uploadSnapshotToR2(1, 99, [
      { path: "index.html", content: "<html></html>", mimeType: "text/html" },
    ]);

    expect(result).toBe(false);
    // fetch should have been called exactly 4 times (1 initial + 3 retries = R2_MAX_ATTEMPTS)
    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
  });
});
