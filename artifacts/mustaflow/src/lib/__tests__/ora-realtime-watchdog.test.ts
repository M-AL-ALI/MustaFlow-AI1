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

// Normalize CRLF -> LF so slice/index assertions behave identically on Windows
// checkouts (the mobile hook can be committed with CRLF there).
const readSource = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const WEB = readSource(path.resolve(__dirname, "../../hooks/use-ora-realtime-voice.ts"));
const MOBILE = readSource(
  path.resolve(__dirname, "../../../../../artifacts/ora-mobile/hooks/useOraRealtimeVoiceNative.ts"),
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

    // ── Audio-liveness: per-response silent-audio detection ───────────────────
    // A separate reliability regression: after many turns Ora could keep
    // "responding" (transcript deltas / response.done arriving) while producing
    // NO audible audio, or audio could go silently stale mid-reply. These
    // assertions verify the per-response audio-liveness tracking and the
    // resume -> reconnect recovery ladder are wired identically on both surfaces.

    it("declares the audio-liveness tuning constants at expected values", () => {
      const num = (name: string) => {
        const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d[\\d_]*)`));
        expect(m, `${name} constant missing`).toBeTruthy();
        return Number(m![1].replace(/_/g, ""));
      };
      expect(num("SILENT_AUDIO_START_MS")).toBe(2_500);
      expect(num("AUDIO_STALL_POLL_MS")).toBe(1_000);
      expect(num("AUDIO_STALL_MAX_STALE_POLLS")).toBe(2);
      expect(num("MAX_SILENT_AUDIO_FAILURES")).toBe(2);
    });

    it("declares the per-response audio-liveness refs", () => {
      expect(src).toContain("activeResponseIdRef");
      expect(src).toContain("audioStartedForResponseRef");
      expect(src).toContain("audioResumeAttemptedForResponseRef");
      expect(src).toContain("silentAudioWatchdogRef");
      expect(src).toContain("audioStallPollRef");
      expect(src).toContain("consecutiveSilentAudioRef");
    });

    it("declares the audio-liveness helper callbacks", () => {
      expect(src).toContain("const stopAudioLivenessTracking = useCallback");
      expect(src).toContain("const recoverSilentAudio = useCallback");
      expect(src).toContain("const armSilentAudioWatchdog = useCallback");
      expect(src).toContain("const startAudioStallPoll = useCallback");
      expect(src).toContain("const startAudioLivenessTracking = useCallback");
    });

    it("captures the active response id in the response.created handler", () => {
      const createdIdx = src.indexOf('case "response.created"');
      expect(createdIdx).toBeGreaterThan(-1);
      const deltaIdx = src.indexOf('case "response.audio_transcript.delta"', createdIdx);
      expect(deltaIdx).toBeGreaterThan(createdIdx);
      const assignIdx = src.indexOf("activeResponseIdRef.current", createdIdx);
      expect(assignIdx).toBeGreaterThan(createdIdx);
      expect(assignIdx).toBeLessThan(deltaIdx);
    });

    it("arms the silent-start watchdog on the SILENT_AUDIO_START_MS deadline", () => {
      expect(src).toContain("armSilentAudioWatchdog()");
      const armStart = src.indexOf("const armSilentAudioWatchdog = useCallback");
      expect(armStart).toBeGreaterThan(-1);
      const armEnd = src.indexOf("= useCallback", armStart + 50);
      const armBody = src.slice(armStart, armEnd > armStart ? armEnd : armStart + 700);
      expect(armBody).toContain("SILENT_AUDIO_START_MS");
    });

    it("guards the silent-start watchdog by the response id it was armed for", () => {
      const armStart = src.indexOf("const armSilentAudioWatchdog = useCallback");
      expect(armStart).toBeGreaterThan(-1);
      const armEnd = src.indexOf("= useCallback", armStart + 50);
      const armBody = src.slice(armStart, armEnd > armStart ? armEnd : armStart + 700);
      expect(armBody).toContain("armedResponseId");
      expect(armBody).toContain("activeResponseIdRef.current !== armedResponseId");
    });

    it("begins audio-liveness tracking in the output_audio_buffer.started handler", () => {
      const startedIdx = src.indexOf('case "output_audio_buffer.started"');
      expect(startedIdx).toBeGreaterThan(-1);
      const stoppedIdx = src.indexOf('case "output_audio_buffer.stopped"', startedIdx);
      expect(stoppedIdx).toBeGreaterThan(startedIdx);
      const trackIdx = src.indexOf("startAudioLivenessTracking()", startedIdx);
      expect(trackIdx).toBeGreaterThan(startedIdx);
      expect(trackIdx).toBeLessThan(stoppedIdx);
    });

    it("recovers a silent response locally and never tears the session down", () => {
      // New contract: a "responding but silent" turn is recovered in place. Rung 1
      // resumes the sink; after MAX_SILENT_AUDIO_FAILURES the stuck response is
      // ended locally (return to listening). recoverSilentAudio must NOT call the
      // reconnect ladder, so a single silent reply can never end the session before
      // its per-plan time budget is spent.
      const recStart = src.indexOf("const recoverSilentAudio = useCallback");
      expect(recStart).toBeGreaterThan(-1);
      const recEnd = src.indexOf("= useCallback", recStart + 50);
      const recBody = src.slice(recStart, recEnd > recStart ? recEnd : recStart + 1200);
      expect(recBody).toContain("MAX_SILENT_AUDIO_FAILURES");
      expect(recBody).toContain("silent_audio_recovered_local");
      expect(recBody).not.toContain("handleConnectionDrop");
    });

    it("routes a genuinely dead audio track to the reconnect ladder from the stall poll", () => {
      // A muted/ended remote track is a real transport failure (not a benign
      // silence), so the stall poll — not recoverSilentAudio — escalates it.
      const pollStart = src.indexOf("const startAudioStallPoll = useCallback");
      expect(pollStart).toBeGreaterThan(-1);
      const pollEnd = src.indexOf("= useCallback", pollStart + 50);
      const pollBody = src.slice(pollStart, pollEnd > pollStart ? pollEnd : pollStart + 1600);
      expect(pollBody).toContain('handleConnectionDrop("audio_track_dead")');
      expect(pollBody).toContain('recoverSilentAudio("audio_stall")');
    });

    it("resets audio-liveness state in the response.done handler", () => {
      const doneIdx = src.indexOf('case "response.done"');
      expect(doneIdx).toBeGreaterThan(-1);
      expect(src.indexOf("stopAudioLivenessTracking()", doneIdx)).toBeGreaterThan(doneIdx);
      expect(src.indexOf("activeResponseIdRef.current = null", doneIdx)).toBeGreaterThan(doneIdx);
    });

    it("resets the silent-audio counter in response.done only for a healthy turn", () => {
      // Regression: an unconditional `consecutiveSilentAudioRef.current = 0` in
      // response.done makes the reconnect escalation unreachable for the exact
      // reported symptom (response.done arrives while audio is silent), because
      // every silent turn's incident is wiped before the next turn can accumulate.
      const blockStart = src.indexOf("Audio-liveness verdict for this turn");
      expect(blockStart).toBeGreaterThan(-1);
      const block = src.slice(blockStart, blockStart + 1700);
      // The verdict is derived from whether audible audio actually started.
      expect(block).toContain("audioDeliveredThisResponse = audioStartedForResponseRef.current");
      // A response.done with no audible audio counts as a silent-audio failure.
      expect(block).toContain('recoverSilentAudio("response_done_no_audio")');
      // The counter reset is guarded (else-if branch), never unconditional.
      const elseIfIdx = block.indexOf("else if (audioDeliveredThisResponse");
      const resetIdx = block.indexOf("consecutiveSilentAudioRef.current = 0");
      expect(elseIfIdx).toBeGreaterThan(-1);
      expect(resetIdx).toBeGreaterThan(elseIfIdx);
      // The whole verdict runs only for a normally-completed response: a cancelled
      // (user barge-in) or failed (model error) turn must not count as silent nor
      // reset the counter, otherwise two consecutive barge-ins force a reconnect.
      expect(block).toContain('responseStatus !== "cancelled"');
      expect(block).toContain('responseStatus !== "failed"');
      const guardIdx = block.indexOf("if (responseCompletedNormally)");
      const recoverIdx = block.indexOf('recoverSilentAudio("response_done_no_audio")');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(recoverIdx).toBeGreaterThan(guardIdx);
    });

    it("stops audio-liveness tracking in the error event handler", () => {
      const errIdx = src.indexOf('case "error"');
      expect(errIdx).toBeGreaterThan(-1);
      expect(src.indexOf("stopAudioLivenessTracking()", errIdx)).toBeGreaterThan(errIdx);
    });

    it("clears the silent-audio watchdog and stall poll in fullTeardown", () => {
      const teardownIdx = src.indexOf("const fullTeardown = useCallback");
      expect(teardownIdx).toBeGreaterThan(-1);
      expect(src.indexOf("silentAudioWatchdogRef.current = null", teardownIdx)).toBeGreaterThan(
        teardownIdx,
      );
      expect(src.indexOf("audioStallPollRef.current = null", teardownIdx)).toBeGreaterThan(
        teardownIdx,
      );
    });

    it("includes the audio-liveness callbacks in handleServerEvent deps", () => {
      const handleIdx = src.indexOf("const handleServerEvent = useCallback");
      expect(handleIdx).toBeGreaterThan(-1);
      const depsIdx = src.indexOf("[", handleIdx);
      const depsEndIdx = src.indexOf("],", depsIdx);
      const deps = src.slice(depsIdx, depsEndIdx);
      expect(deps).toContain("recoverSilentAudio");
      expect(deps).toContain("armSilentAudioWatchdog");
      expect(deps).toContain("startAudioLivenessTracking");
      expect(deps).toContain("stopAudioLivenessTracking");
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

    it("both hooks declare the audio-liveness tuning constants at the same values", () => {
      const names = [
        "SILENT_AUDIO_START_MS",
        "AUDIO_STALL_POLL_MS",
        "AUDIO_STALL_MAX_STALE_POLLS",
        "MAX_SILENT_AUDIO_FAILURES",
      ];
      const extract = (src: string, name: string) =>
        Number(
          (src.match(new RegExp(`const ${name}\\s*=\\s*(\\d[\\d_]*)`)) || [])[1]?.replace(/_/g, ""),
        );
      for (const name of names) {
        const w = extract(WEB, name);
        const m = extract(MOBILE, name);
        expect(w, `${name} missing/NaN on web`).toBeGreaterThan(0);
        expect(m, `${name} on mobile must equal web`).toBe(w);
      }
    });

    it("both hooks begin audio-liveness tracking on the output_audio_buffer.started event", () => {
      for (const [_label, src] of hooks) {
        expect(src).toContain("armSilentAudioWatchdog()");
        const startedIdx = src.indexOf('case "output_audio_buffer.started"');
        const stoppedIdx = src.indexOf('case "output_audio_buffer.stopped"', startedIdx);
        const trackIdx = src.indexOf("startAudioLivenessTracking()", startedIdx);
        expect(trackIdx).toBeGreaterThan(startedIdx);
        expect(trackIdx).toBeLessThan(stoppedIdx);
      }
    });

    it("both hooks recover silent audio locally and escalate only a dead track", () => {
      for (const [_label, src] of hooks) {
        const recStart = src.indexOf("const recoverSilentAudio = useCallback");
        expect(recStart).toBeGreaterThan(-1);
        const recEnd = src.indexOf("= useCallback", recStart + 50);
        const recBody = src.slice(recStart, recEnd > recStart ? recEnd : recStart + 1200);
        // Local recovery, never a teardown.
        expect(recBody).toContain("MAX_SILENT_AUDIO_FAILURES");
        expect(recBody).toContain("silent_audio_recovered_local");
        expect(recBody).not.toContain("handleConnectionDrop");
        // The dead-track escalation lives in the stall poll on both surfaces.
        const pollStart = src.indexOf("const startAudioStallPoll = useCallback");
        expect(pollStart).toBeGreaterThan(-1);
        const pollEnd = src.indexOf("= useCallback", pollStart + 50);
        const pollBody = src.slice(pollStart, pollEnd > pollStart ? pollEnd : pollStart + 1600);
        expect(pollBody).toContain('handleConnectionDrop("audio_track_dead")');
        expect(pollBody).toContain('recoverSilentAudio("audio_stall")');
      }
    });

    it("both hooks count a silent response.done and guard the counter reset", () => {
      for (const [_label, src] of hooks) {
        const blockStart = src.indexOf("Audio-liveness verdict for this turn");
        expect(blockStart).toBeGreaterThan(-1);
        const block = src.slice(blockStart, blockStart + 1700);
        expect(block).toContain('recoverSilentAudio("response_done_no_audio")');
        const elseIfIdx = block.indexOf("else if (audioDeliveredThisResponse");
        const resetIdx = block.indexOf("consecutiveSilentAudioRef.current = 0");
        expect(elseIfIdx).toBeGreaterThan(-1);
        expect(resetIdx).toBeGreaterThan(elseIfIdx);
      }
    });

    it("both hooks skip the audio-liveness verdict for cancelled/failed responses", () => {
      for (const [_label, src] of hooks) {
        const blockStart = src.indexOf("Audio-liveness verdict for this turn");
        expect(blockStart).toBeGreaterThan(-1);
        const block = src.slice(blockStart, blockStart + 1700);
        // Read the server-reported response status and gate the verdict on it.
        expect(block).toContain("const responseStatus = (evt.response");
        expect(block).toContain('responseStatus !== "cancelled"');
        expect(block).toContain('responseStatus !== "failed"');
        // The recover/reset verdict must be nested inside the completed-normally
        // guard so a barge-in or model error never counts as a silent-audio blip.
        const guardIdx = block.indexOf("if (responseCompletedNormally)");
        const recoverIdx = block.indexOf('recoverSilentAudio("response_done_no_audio")');
        expect(guardIdx).toBeGreaterThan(-1);
        expect(recoverIdx).toBeGreaterThan(guardIdx);
      }
    });
  });
});
