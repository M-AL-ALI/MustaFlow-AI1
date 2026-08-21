/**
 * Source-string regression tests for TestFlight build #39 release-blocking fixes.
 *
 * Blocker 1 — Session 429 / billing mismatch:
 *   - Server skips oraSessionLimiter for authenticated users (IP cap only for anon)
 *   - Mobile diagnostics session step uses GET-first (non-destructive) then POST on 401
 *
 * Blocker 2 — Realtime voice transport diagnostic:
 *   - Mobile diagnostics has a dedicated realtime step in initSteps()
 *   - runDiagnostics() checks WebRTC native module availability + server config
 *
 * Blocker 3 — Billing deep links (already implemented):
 *   - See pricing-deeplink.test.ts — all 14 assertions pass
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  extractNamedDeclaration,
  extractNamedFunction,
} from "../../../../api-server/src/lib/source-ast-test-helper";

const ARTIFACTS = join(__dirname, "../../../../");

function readFile(relPath: string): string {
  return readFileSync(join(ARTIFACTS, relPath), "utf-8");
}

// ─── Blocker 1 — Server: rate limiter bypasses authenticated users ─────────

describe("Blocker 1 — server session rate limiter auth bypass", () => {
  const SESSION_ROUTE = "api-server/src/routes/public-ai/session.ts";

  it("sessionRateLimiter imports and calls getAuth from @clerk/express", () => {
    const src = readFile(SESSION_ROUTE);
    expect(src).toContain("getAuth");
    expect(src).toContain("@clerk/express");
  });

  it("sessionRateLimiter skips oraSessionLimiter when getAuth(req).userId is present", () => {
    const src = readFile(SESSION_ROUTE);
    const fn = extractNamedFunction(src, "sessionRateLimiter");
    // Must guard with getAuth(req).userId
    expect(fn).toContain("getAuth(req).userId");
    // Must have early next() return before oraSessionLimiter
    const authBypassPos = fn.indexOf("getAuth(req).userId");
    const limiterCallPos = fn.indexOf("oraSessionLimiter(req");
    expect(authBypassPos).toBeGreaterThan(-1);
    expect(limiterCallPos).toBeGreaterThan(-1);
    expect(authBypassPos).toBeLessThan(limiterCallPos);
  });
});

// ─── Blocker 1 — Mobile diagnostics: GET-first session check ─────────────

describe("Blocker 1 — mobile diagnostics session step uses GET-first", () => {
  const SETTINGS = "ora-mobile/app/(home)/settings.tsx";

  it("session step tries GET before POST", () => {
    const src = readFile(SETTINGS);
    const sessionBlock = extractNamedDeclaration(src, "runDiagnostics", "tsx");
    expect(sessionBlock).toContain('updateStep("session", { status: "running" }');
    expect(sessionBlock).toContain('updateStep("chat", { status: "running" }');
    const getPos = sessionBlock.indexOf('"GET"');
    const postPos = sessionBlock.indexOf('"POST"');
    expect(getPos).toBeGreaterThan(-1);
    expect(postPos).toBeGreaterThan(-1);
    expect(getPos).toBeLessThan(postPos);
  });

  it("session step falls back to POST only on 401", () => {
    const src = readFile(SETTINGS);
    const sessionBlock = extractNamedDeclaration(src, "runDiagnostics", "tsx");
    expect(sessionBlock).toContain("r.status === 401");
    expect(sessionBlock).toContain('"POST"');
  });

  it("session step label reflects the GET/POST hybrid approach", () => {
    const src = readFile(SETTINGS);
    expect(src).toContain('"Ora session (GET/POST)"');
  });
});

// ─── Blocker 2 — Mobile diagnostics: realtime transport step ─────────────

describe("Blocker 2 — mobile diagnostics has realtime transport step", () => {
  const SETTINGS = "ora-mobile/app/(home)/settings.tsx";

  it("initSteps() includes a realtime step with correct id and label", () => {
    const src = readFile(SETTINGS);
    expect(src).toContain('id: "realtime"');
    expect(src).toContain('"Realtime voice transport"');
  });

  it("realtime step url points to the diagnostics endpoint", () => {
    const src = readFile(SETTINGS);
    expect(src).toContain("realtime/diagnostics");
  });

  it("runDiagnostics() updates the realtime step", () => {
    const src = readFile(SETTINGS);
    expect(src).toContain('updateStep("realtime"');
  });

  it("runDiagnostics() realtime block checks WebRTC native module and server config", () => {
    const src = readFile(SETTINGS);
    const rtBlock = extractNamedDeclaration(src, "runDiagnostics", "tsx");
    expect(rtBlock).toContain('updateStep("realtime", { status: "running" }');
    expect(rtBlock).toContain('updateStep("transport", { status: "running" }');
    expect(rtBlock).toContain("isRealtimeVoiceNativeAvailable()");
    expect(rtBlock).toContain("getRealtimeDiagnostics()");
  });

  it("realtime step shows WebRTC module not available message when native is missing", () => {
    const src = readFile(SETTINGS);
    expect(src).toContain("WebRTC module not in this build");
  });

  it("realtime step shows server-ready message when both module and server are available", () => {
    const src = readFile(SETTINGS);
    expect(src).toContain("WebRTC ready");
  });
});
