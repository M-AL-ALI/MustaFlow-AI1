import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mapOraStreamDiagnostics } from "../use-ora-chat";
import { extractInnermostIfContainingText } from "../../../../api-server/src/lib/source-ast-test-helper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per-response chat diagnostics parity with mobile (website side).
 *
 * The web StreamDonePayload used to drop the backend `serverDiag` timing block,
 * so the website had no user-facing per-response diagnostics (mobile did). This
 * suite locks in the pure mapper plus the capture wiring inside consumeOraStream.
 */
describe("mapOraStreamDiagnostics", () => {
  it("maps server timing fields and normalizes missing values to null", () => {
    const diag = mapOraStreamDiagnostics({
      mode: "instant",
      tapToFirstTokenMs: 120,
      firstSentenceMs: 240,
      completeMs: 900,
      tokenCount: 42,
      viaFallback: false,
      serverDiag: {
        ttftMs: 80,
        totalMs: 850,
        provider: "gemini",
        routeTier: "fast",
        fastLane: true,
      },
    });

    expect(diag.mode).toBe("instant");
    expect(diag.tapToFirstTokenMs).toBe(120);
    expect(diag.firstSentenceMs).toBe(240);
    expect(diag.completeMs).toBe(900);
    expect(diag.tokenCount).toBe(42);
    expect(diag.viaFallback).toBe(false);
    expect(diag.serverTtftMs).toBe(80);
    expect(diag.serverTotalMs).toBe(850);
    expect(diag.serverProvider).toBe("gemini");
    expect(diag.serverRouteTier).toBe("fast");
    expect(diag.serverFastLane).toBe(true);
    expect(typeof diag.capturedAt).toBe("number");
  });

  it("defaults unknown mode and absent serverDiag to safe values", () => {
    const diag = mapOraStreamDiagnostics({
      mode: undefined,
      tapToFirstTokenMs: null,
      firstSentenceMs: null,
      completeMs: null,
      tokenCount: 0,
      viaFallback: true,
    });

    expect(diag.mode).toBe("unknown");
    expect(diag.serverTtftMs).toBeNull();
    expect(diag.serverTotalMs).toBeNull();
    expect(diag.serverProvider).toBeNull();
    expect(diag.serverRouteTier).toBeNull();
    expect(diag.serverFastLane).toBeNull();
    expect(diag.viaFallback).toBe(true);
  });
});

describe("use-ora-chat diagnostics capture wiring", () => {
  const src = readFileSync(path.join(__dirname, "../use-ora-chat.ts"), "utf8");

  it("carries serverDiag through the stream done payload", () => {
    expect(src).toContain("serverDiag?:");
    expect(src).toContain("serverDiag: donePayload.serverDiag");
  });

  it("captures client-side timing inside consumeOraStream", () => {
    expect(src).toContain("firstTokenMs = Date.now() - callStart");
    expect(src).toContain("firstSentenceMs = Date.now() - callStart");
    expect(src).toContain("completeMs: Date.now() - callStart");
  });

  it("records a fallback diagnostic on the non-streaming /chat path", () => {
    const after = extractInnermostIfContainingText(
      src,
      'apiPost<ChatResponseData>("/api/public-ai/chat", body)',
      "tsx",
    );
    expect(after).toContain('apiPost<ChatResponseData>("/api/public-ai/chat"');
    expect(after).toContain("viaFallback: true");
    expect(after).toContain("setLastOraStreamDiagnostics");
  });

  it("reconciles viaFallback once real-streaming status is known", () => {
    expect(src).toContain("setLastOraStreamDiagnostics({ ...lastDiag, viaFallback })");
  });

  it("forwards SSE status text for reasoning-stage progress", () => {
    expect(src).toContain('} else if (eventType === "status") {');
    expect(src).toContain("onStatus?.((parsed as { text: string }).text)");
  });

  it("shows a named progress line while retrying through /chat fallback", () => {
    expect(src).toContain('setStreamStatus("Finishing the answer...")');
  });

  it("does not render the opaque Non-streamed badge in the chat panel", () => {
    const panel = readFileSync(path.join(__dirname, "../../components/ora-panel.tsx"), "utf8");
    expect(panel).not.toContain("Non-streamed");
  });
});
