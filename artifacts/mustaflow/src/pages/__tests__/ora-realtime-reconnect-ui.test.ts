/**
 * Source-string assertions: ora-panel.tsx UI wiring for reconnect states.
 *
 * These tests verify that the quality-dot, fallback notice, and Retry button
 * are correctly wired to the networkQuality / fallbackReason values produced
 * by the hook — without requiring a full DOM render of the panel.
 *
 * The pattern mirrors ora-live-voice-privacy.test.ts.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const COMPONENTS = join(__dirname, "..", "..", "components");
const HOOKS = join(__dirname, "..", "..", "hooks");

const panel = readFileSync(join(COMPONENTS, "ora-panel.tsx"), "utf-8");
const webHook = readFileSync(join(HOOKS, "use-ora-realtime-voice.ts"), "utf-8");

describe("ora-panel — quality-dot state wiring (web)", () => {
  it("shows the quality-dot when realtimeActive OR when reconnecting while voiceConvActive", () => {
    // showQualityDot must be gated on reconnecting so the dot persists during
    // the auto-reconnect window even if voiceTransport has flipped to fallback.
    expect(panel).toContain('networkQuality === "reconnecting"');
    expect(panel).toMatch(/showQualityDot\s*=[\s\S]{0,120}networkQuality === "reconnecting"/);
  });

  it("maps 'reconnecting' networkQuality to a pulsing amber dot with the correct label", () => {
    // Amber color for reconnecting (same as degraded — visible warning).
    expect(panel).toContain('"Reconnecting live voice…"');
    // The dot pulses while reconnecting.
    expect(panel).toMatch(/"reconnecting"[\s\S]{0,200}pulse: true/);
  });

  it("maps 'good' networkQuality to a green dot that does not pulse", () => {
    expect(panel).toContain('"Live voice connection is stable"');
    expect(panel).toMatch(/"good"[\s\S]{0,120}pulse: false/);
  });

  it("maps 'legacy' networkQuality to a grey dot (basic voice mode label)", () => {
    // After auto-reconnect budget exhausted, grey dot.
    expect(panel).toContain('"Using basic voice mode"');
  });

  it("renders the qualityDot label as both title and aria-label for accessibility", () => {
    expect(panel).toContain("title={qualityDot.label}");
    expect(panel).toContain("aria-label={qualityDot.label}");
  });
});

describe("ora-panel — fallback notice and Retry button wiring", () => {
  it("renders fallbackNotice only when voiceTransport is 'fallback' and not dismissed", () => {
    expect(panel).toMatch(/fallbackNotice\s*=[\s\S]{0,80}voiceTransport === "fallback"/);
    expect(panel).toContain("!fallbackNoticeDismissed");
  });

  it("falls back to a default human-readable string when fallbackReason is null", () => {
    expect(panel).toContain(
      "Live voice is unavailable right now. Using standard voice mode instead.",
    );
  });

  it("shows the Retry button exactly when networkQuality is 'legacy'", () => {
    // showRetry tied to legacy quality — one auto-reconnect used, back to basics.
    expect(panel).toContain('showRetry={realtime.networkQuality === "legacy"}');
  });

  it("passes fallbackNotice (which carries fallbackReason) to OraVoiceModeButton", () => {
    expect(panel).toContain("fallbackNotice={fallbackNotice}");
  });
});

describe("web hook — reconnect budget correctness", () => {
  it("exposes networkQuality from the hook return value", () => {
    expect(webHook).toContain("networkQuality,");
  });

  it("exposes fallbackReason from the hook return value", () => {
    expect(webHook).toContain("fallbackReason,");
  });

  it("exposes retry() so the UI can rebuild the live session", () => {
    expect(webHook).toContain("retry,");
  });

  it("sets networkQuality to 'reconnecting' when a drop is detected", () => {
    expect(webHook).toContain('"reconnecting"');
  });

  it("sets networkQuality to 'legacy' after the auto-reconnect budget is exhausted", () => {
    expect(webHook).toContain('"legacy"');
  });
});
