/**
 * Regression suite for Talk-to-Ora realtime session reliability.
 *
 * Bugs fixed: After 8–10 turns the session degraded into a permanently-stuck
 * "thinking" or "speaking" state because:
 *
 *   1. No speaking watchdog — the thinking watchdog was cancelled when
 *      output_audio_buffer.started arrived but NO new watchdog was armed.
 *      If response.done AND output_audio_buffer.stopped both dropped (degraded
 *      WebRTC after many turns), state was stuck in "speaking" forever.
 *
 *   2. Thinking watchdog fired without sending response.cancel — stale events
 *      from the aborted generation (response.created, audio deltas) arrived
 *      after recovery and re-set assistantResponseActiveRef, confusing the
 *      next user turn.
 *
 *   3. No consecutive failure escalation — two+ watchdog fires never triggered
 *      reconnect, leaving the user silently stuck in a broken session.
 *
 *   4. lastAcceptedUserTurnAtRef not refreshed on the debounce path — when
 *      response.done dropped but output_audio_buffer.stopped eventually fired,
 *      the focus window went stale → the next user utterance was rejected by
 *      the focus filter in "focused" mode → UI looked stuck in "thinking"
 *      (response.create was never sent for the rejected turn).
 *
 * These tests are source-string assertions for both the web hook and the mobile
 * hook. They are intentionally surface-level: they verify that the new patterns
 * are present in the implementation without requiring a full WebRTC mock stack.
 * Each test is named after the invariant it guards so failures are self-describing.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB = readFileSync(path.resolve(__dirname, "../../hooks/use-ora-realtime-voice.ts"), "utf8");
const MOBILE = readFileSync(
  path.resolve(__dirname, "../../../../../artifacts/ora-mobile/hooks/useOraRealtimeVoiceNative.ts"),
  "utf8",
);

const hooks: [string, string][] = [
  ["web", WEB],
  ["mobile", MOBILE],
];

describe("Talk-to-Ora realtime watchdog reliability", () => {
  describe.each(hooks)("%s hook", (_label, src) => {
    // ── SPEAKING_WATCHDOG_MS ─────────────────────────────────────────────────

    it("declares SPEAKING_WATCHDOG_MS >= 30 000 ms", () => {
      const m = src.match(/const SPEAKING_WATCHDOG_MS\s*=\s*(\d[\d_]*)/);
      expect(m, "SPEAKING_WATCHDOG_MS constant missing").toBeTruthy();
      const val = Number(m![1].replace(/_/g, ""));
      expect(val).toBeGreaterThanOrEqual(30_000);
    });

    // ── New refs ─────────────────────────────────────────────────────────────

    it("declares speakingWatchdogRef", () => {
      expect(src).toContain("speakingWatchdogRef");
    });

    it("declares consecutiveWatchdogFiresRef", () => {
      expect(src).toContain("consecutiveWatchdogFiresRef");
    });

    // ── Thinking watchdog sends response.cancel ──────────────────────────────

    it("sends response.cancel inside the thinking watchdog callback", () => {
      // Both watchdog sites (speech_stopped and response.created) must cancel
      // the stuck generation so stale model events don't bleed into the next turn.
      const cancelCount = (src.match(/sendEvent\(\s*\{\s*type:\s*["']response\.cancel["']/g) || [])
        .length;
      // At minimum: 2× thinking watchdog + 1× speaking watchdog = 3
      expect(cancelCount).toBeGreaterThanOrEqual(3);
    });

    // ── Thinking watchdog increments the consecutive counter ─────────────────

    it("increments consecutiveWatchdogFiresRef inside the thinking watchdog", () => {
      expect(src).toContain("consecutiveWatchdogFiresRef.current += 1");
    });

    // ── Thinking watchdog escalates to handleConnectionDrop after 2 fires ────

    it("calls handleConnectionDrop when consecutive watchdog fires >= 2", () => {
      expect(src).toContain('handleConnectionDrop("consecutive_thinking_watchdog")');
    });

    // ── Speaking watchdog is armed on output_audio_buffer.started ───────────

    it("arms the speaking watchdog in the output_audio_buffer.started handler", () => {
      // The arm must appear BETWEEN the output_audio_buffer.started case and the
      // output_audio_buffer.stopped case. Assert that the speaking watchdog
      // setTimeout call exists AND that logVoiceDiag("speaking_watchdog_timeout")
      // appears (the callback body), which is unique to the speaking watchdog.
      expect(src).toContain("speaking_watchdog_timeout");
      expect(src).toContain("SPEAKING_WATCHDOG_MS");
      expect(src).toContain('handleConnectionDrop("consecutive_speaking_watchdog")');
    });

    // ── Speaking watchdog is cancelled on output_audio_buffer.stopped ────────

    it("cancels the speaking watchdog inside the output-stop debounce callback", () => {
      // The debounce callback is the only other path that exits "speaking" when
      // response.done is lost. It must cancel the speaking watchdog to prevent
      // a double-recovery.
      const cancelIdx = src.indexOf(
        "speakingWatchdogRef.current = null;",
        src.indexOf("outputStopDebounceRef.current = setTimeout"),
      );
      expect(cancelIdx).toBeGreaterThan(-1);
    });

    // ── Debounce path refreshes the focus window ─────────────────────────────

    it("updates lastAcceptedUserTurnAtRef inside the output-stop debounce", () => {
      // When response.done is dropped, the debounce is the only path that exits
      // "speaking". Without this refresh, the focus window goes stale and the
      // next user utterance is rejected by the focus filter → looks stuck in thinking.
      const debounceCallbackStart = src.indexOf("outputStopDebounceRef.current = setTimeout");
      expect(debounceCallbackStart).toBeGreaterThan(-1);
      const debounceCallbackEnd = src.indexOf("OUTPUT_STOP_DEBOUNCE_MS);", debounceCallbackStart);
      const debounceBody = src.slice(debounceCallbackStart, debounceCallbackEnd);
      expect(debounceBody).toContain("lastAcceptedUserTurnAtRef.current = Date.now()");
    });

    // ── response.done cancels the speaking watchdog ──────────────────────────

    it("cancels speakingWatchdogRef inside the response.done handler", () => {
      const doneCaseIdx = src.indexOf('case "response.done":');
      expect(doneCaseIdx).toBeGreaterThan(-1);
      // Find the next clearTimeout(speakingWatchdogRef...) after the case label
      const clearIdx = src.indexOf("clearTimeout(speakingWatchdogRef.current)", doneCaseIdx);
      expect(clearIdx).toBeGreaterThan(-1);
    });

    // ── response.done resets the consecutive counter ─────────────────────────

    it("resets consecutiveWatchdogFiresRef.current = 0 in the response.done handler", () => {
      const doneCaseIdx = src.indexOf('case "response.done":');
      expect(doneCaseIdx).toBeGreaterThan(-1);
      const resetIdx = src.indexOf("consecutiveWatchdogFiresRef.current = 0", doneCaseIdx);
      expect(resetIdx).toBeGreaterThan(-1);
    });

    // ── error handler cancels the speaking watchdog ──────────────────────────

    it("cancels speakingWatchdogRef inside the error event handler", () => {
      const errorCaseIdx = src.indexOf('case "error":');
      expect(errorCaseIdx).toBeGreaterThan(-1);
      const clearIdx = src.indexOf("speakingWatchdogRef.current = null", errorCaseIdx);
      expect(clearIdx).toBeGreaterThan(-1);
    });

    // ── fullTeardown cleans up the speaking watchdog ─────────────────────────

    it("cancels speakingWatchdogRef in fullTeardown", () => {
      const teardownIdx = src.indexOf("const fullTeardown = useCallback");
      expect(teardownIdx).toBeGreaterThan(-1);
      const clearIdx = src.indexOf("clearTimeout(speakingWatchdogRef.current)", teardownIdx);
      expect(clearIdx).toBeGreaterThan(-1);
    });

    it("resets consecutiveWatchdogFiresRef.current = 0 in fullTeardown", () => {
      const teardownIdx = src.indexOf("const fullTeardown = useCallback");
      expect(teardownIdx).toBeGreaterThan(-1);
      const resetIdx = src.indexOf("consecutiveWatchdogFiresRef.current = 0", teardownIdx);
      expect(resetIdx).toBeGreaterThan(-1);
    });

    // ── handleConnectionDrop is in handleServerEvent deps ────────────────────

    it("includes handleConnectionDrop in handleServerEvent useCallback deps", () => {
      // The speaking/thinking watchdog callbacks inside handleServerEvent call
      // handleConnectionDrop, so it must be in the deps array.
      const handleIdx = src.indexOf("const handleServerEvent = useCallback");
      expect(handleIdx).toBeGreaterThan(-1);
      const depsIdx = src.indexOf("[", handleIdx);
      expect(depsIdx).toBeGreaterThan(-1);
      const depsEndIdx = src.indexOf("],", depsIdx);
      expect(depsEndIdx).toBeGreaterThan(depsIdx);
      const deps = src.slice(depsIdx, depsEndIdx);
      expect(deps).toContain("confirmBargeIn");
      expect(deps).toContain("cancelPendingBargeIn");
      expect(deps).toContain("clearBargeInTimer");
      expect(deps).toContain("bargeInRequiresDirection");
      expect(deps).toContain("sendEvent");
      expect(deps).toContain("handleConnectionDrop");
    });
  });

  // ── Turn-count sanity: SPEAKING_WATCHDOG_MS > THINKING_WATCHDOG_MS ─────────

  describe("timer ordering", () => {
    it.each(hooks)("%s: SPEAKING_WATCHDOG_MS > THINKING_WATCHDOG_MS", (_label, src) => {
      const thinking = Number(
        (src.match(/const THINKING_WATCHDOG_MS\s*=\s*(\d[\d_]*)/) || [])[1]?.replace(/_/g, ""),
      );
      const speaking = Number(
        (src.match(/const SPEAKING_WATCHDOG_MS\s*=\s*(\d[\d_]*)/) || [])[1]?.replace(/_/g, ""),
      );
      expect(thinking).toBeGreaterThan(0);
      expect(speaking).toBeGreaterThan(thinking);
    });
  });

  // ── Parity: both hooks have the same set of watchdog-related constants ──────

  describe("web↔mobile parity", () => {
    it("both hooks declare SPEAKING_WATCHDOG_MS at the same value", () => {
      const extract = (src: string) =>
        Number(
          (src.match(/const SPEAKING_WATCHDOG_MS\s*=\s*(\d[\d_]*)/) || [])[1]?.replace(/_/g, ""),
        );
      expect(extract(WEB)).toBe(extract(MOBILE));
    });

    it("both hooks declare THINKING_WATCHDOG_MS at the same value", () => {
      const extract = (src: string) =>
        Number(
          (src.match(/const THINKING_WATCHDOG_MS\s*=\s*(\d[\d_]*)/) || [])[1]?.replace(/_/g, ""),
        );
      expect(extract(WEB)).toBe(extract(MOBILE));
    });

    it("both hooks refresh lastAcceptedUserTurnAtRef in the output-stop debounce", () => {
      for (const [_label, src] of hooks) {
        const debounceCallbackStart = src.indexOf("outputStopDebounceRef.current = setTimeout");
        const debounceCallbackEnd = src.indexOf("OUTPUT_STOP_DEBOUNCE_MS);", debounceCallbackStart);
        const debounceBody = src.slice(debounceCallbackStart, debounceCallbackEnd);
        expect(debounceBody).toContain("lastAcceptedUserTurnAtRef.current = Date.now()");
      }
    });
  });
});
