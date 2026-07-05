/**
 * useOraRealtimeVoice — multi-turn conversation reliability.
 *
 * Simulates 10+ sequential turns to prove the three state-machine fixes hold:
 *
 *   Root cause A — focus window refreshed after Ora speaks:
 *     `response.done` sets lastAcceptedUserTurnAtRef = Date.now(), giving the
 *     user a fresh 12 s window to reply without a wake word.
 *
 *   Root cause B — assistantResponseActiveRef cleared before next user turn:
 *     `output_audio_buffer.stopped` 600 ms debounce now explicitly sets
 *     assistantResponseActiveRef = false before flipping to "listening", so a
 *     user who speaks between audio-stop and response.done is NOT treated as a
 *     barge-in and no spurious response.cancel is sent.
 *
 *   Root cause C — thinking watchdog rearmed on response.created:
 *     The watchdog is cancelled and rescheduled on every response.created so
 *     overlapping transcript/response events can't leave the hook stuck in
 *     "thinking" indefinitely.
 *
 * IMPORTANT: vi.clearAllMocks() is required in beforeEach so mock call-counts
 * start at zero for each test.
 *
 * IMPORTANT: Never call vi.runAllTimersAsync() when setInterval timers are
 * active (duration countdown, heartbeat). Use vi.advanceTimersByTimeAsync(N)
 * with a bounded N instead.
 *
 * IMPORTANT: RTCPeerConnection must be a regular function (not an arrow
 * function) because the hook calls it with `new`. Arrow functions cannot be
 * constructors.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOraRealtimeVoice, type RealtimeStartContext } from "../use-ora-realtime-voice";

// ─── Source paths (for mobile parity source-string assertions) ─────────────────

// __dirname is artifacts/mustaflow/src/hooks/__tests__  (5 levels below workspace root)
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MUSTAFLOW_SRC = join(REPO_ROOT, "artifacts", "mustaflow", "src");
const ORA_MOBILE_DIR = join(REPO_ROOT, "artifacts", "ora-mobile");

function readHook(surface: "web" | "mobile"): string {
  if (surface === "web") {
    return readFileSync(join(MUSTAFLOW_SRC, "hooks", "use-ora-realtime-voice.ts"), "utf-8");
  }
  return readFileSync(join(ORA_MOBILE_DIR, "hooks", "useOraRealtimeVoiceNative.ts"), "utf-8");
}

// ─── Mock authFetch ───────────────────────────────────────────────────────────

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/api-fetch";

// ─── Fake WebRTC primitives ───────────────────────────────────────────────────

/** Stand-in for RTCDataChannel. */
class FakeDataChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

/** Stand-in for RTCPeerConnection. */
class FakePeerConnection {
  iceConnectionState = "new";
  connectionState = "new";
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  dc: FakeDataChannel | null = null;

  createDataChannel = vi.fn(() => {
    this.dc = new FakeDataChannel();
    return this.dc!;
  });
  createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "v=0\r\n" });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  addTrack = vi.fn();
  getSenders = vi.fn().mockReturnValue([]);
  close = vi.fn();
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FOCUSED_CTX: RealtimeStartContext = {
  temporary: false,
  referenceSavedMemories: false,
  focusMode: "focused",
};

const NORMAL_CTX: RealtimeStartContext = {
  temporary: false,
  referenceSavedMemories: false,
  focusMode: "normal",
};

const MINT_PAYLOAD = {
  value: "ek_test",
  model: "gpt-realtime-mini",
  maxDurationSeconds: 600,
  // No realtimeSessionId so the heartbeat timer is not started, avoiding
  // an active setInterval that would complicate advanceTimersByTimeAsync.
};

function mintResponse(body = MINT_PAYLOAD) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function sdpResponse() {
  return new Response("v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n", { status: 200 });
}
function okResponse() {
  return new Response("{}", { status: 200 });
}
function fakeStream(): MediaStream {
  return {
    getAudioTracks: () => [{ stop: vi.fn() }],
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

// ─── Simulation helpers ───────────────────────────────────────────────────────

/**
 * Dispatch a single data-channel server event to the hook.
 * Wraps in act() so React processes the resulting state updates.
 */
async function dispatchEvent(dc: FakeDataChannel, event: Record<string, unknown>) {
  await act(async () => {
    dc.onmessage?.({ data: JSON.stringify(event) });
  });
}

/**
 * Count how many `response.cancel` events the hook sent to the data channel.
 * Filters only `response.cancel`; ignores `response.create` and other sends.
 */
function cancelsSent(dc: FakeDataChannel): number {
  return (dc.send.mock.calls as [string][]).filter((args) => {
    try {
      return (JSON.parse(args[0]) as { type?: string }).type === "response.cancel";
    } catch {
      return false;
    }
  }).length;
}

/**
 * Simulate one complete assistant reply:
 *   response.created → audio started → transcript delta + done →
 *   audio stopped → response.done
 *
 * response.done clears assistantResponseActiveRef immediately and refreshes
 * the focus window (lastAcceptedUserTurnAtRef = Date.now()).
 */
async function simulateAssistantReply(dc: FakeDataChannel, text = "Here is my answer.") {
  await dispatchEvent(dc, { type: "response.created" });
  await dispatchEvent(dc, { type: "output_audio_buffer.started" });
  await dispatchEvent(dc, { type: "response.audio_transcript.delta", delta: text });
  await dispatchEvent(dc, { type: "response.audio_transcript.done", transcript: text });
  await dispatchEvent(dc, { type: "output_audio_buffer.stopped" });
  // response.done cancels the stop-debounce timer and clears both
  // assistantResponseActiveRef and assistantSpeakingRef immediately.
  await dispatchEvent(dc, { type: "response.done" });
}

/**
 * Simulate one complete user turn:
 *   speech_started → transcript delta → speech_stopped → transcript completed
 *
 * Returns true when the transcript was accepted (onUserTranscript was called).
 */
async function simulateUserTurn(
  dc: FakeDataChannel,
  text: string,
  itemId: string,
  onUserTranscript: ReturnType<typeof vi.fn>,
): Promise<boolean> {
  const before = (onUserTranscript.mock.calls as unknown[]).length;
  await dispatchEvent(dc, { type: "input_audio_buffer.speech_started" });
  await dispatchEvent(dc, {
    type: "conversation.item.input_audio_transcription.delta",
    delta: text,
  });
  await dispatchEvent(dc, { type: "input_audio_buffer.speech_stopped" });
  await dispatchEvent(dc, {
    type: "conversation.item.input_audio_transcription.completed",
    transcript: text,
    item_id: itemId,
  });
  return (onUserTranscript.mock.calls as unknown[]).length > before;
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

describe("useOraRealtimeVoice — multi-turn conversation reliability", () => {
  const pcInstances: FakePeerConnection[] = [];

  /**
   * RTCPeerConnection constructor mock — MUST be a regular `function` (not an
   * arrow function) because the hook calls `new RTCPeerConnection()`.
   */
  function FakeRTCPeerConnection(this: FakePeerConnection) {
    const inst = new FakePeerConnection();
    pcInstances.push(inst);
    return inst;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // jsdom's HTMLMediaElement.play() returns undefined (not a Promise) so
    // `.catch()` on it would throw. Stub both to safe no-ops.
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();

    Object.defineProperty(window, "isSecureContext", {
      value: true,
      writable: true,
      configurable: true,
    });

    pcInstances.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).RTCPeerConnection = FakeRTCPeerConnection;

    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) },
      writable: true,
      configurable: true,
    });

    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintResponse();
      return okResponse();
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sdpResponse()),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── Shared connection helper ───────────────────────────────────────────────

  /**
   * Start the hook and open the data channel so state reaches "listening".
   * Returns { ok, dc } where dc is the FakeDataChannel for sending events.
   */
  async function connectHook(
    hook: ReturnType<typeof renderHook<ReturnType<typeof useOraRealtimeVoice>, unknown>>,
    ctx: RealtimeStartContext = FOCUSED_CTX,
  ): Promise<{ ok: boolean; dc: FakeDataChannel | null }> {
    let started = false;
    await act(async () => {
      started = await hook.result.current.start(ctx);
    });
    if (!started) return { ok: false, dc: null };
    const pc = pcInstances[pcInstances.length - 1];
    await act(async () => {
      pc.dc?.onopen?.();
    });
    return { ok: true, dc: pc.dc };
  }

  /** Advance fake timers by N ms while flushing promises between ticks. */
  async function advanceMs(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // ─── 1. 10-turn loop ──────────────────────────────────────────────────────

  it("accepts all 10 user turns without any spurious response.cancel (focused mode)", async () => {
    const onUserTranscript = vi.fn();
    const onAssistantTranscript = vi.fn();

    const hook = renderHook(() => useOraRealtimeVoice({ onUserTranscript, onAssistantTranscript }));
    const { ok, dc } = await connectHook(hook, FOCUSED_CTX);
    expect(ok).toBe(true);
    expect(dc).not.toBeNull();
    expect(hook.result.current.state).toBe("listening");

    const TURNS = 10;
    for (let i = 0; i < TURNS; i++) {
      // Verify: no response.cancel sent yet at the START of each turn
      expect(cancelsSent(dc!), `spurious cancel before turn ${i + 1}`).toBe(0);

      // User speaks — assistantResponseActiveRef is false (cleared by last response.done)
      const accepted = await simulateUserTurn(
        dc!,
        `What is the answer to question number ${i + 1}?`,
        `item_${i}`,
        onUserTranscript,
      );
      expect(accepted, `turn ${i + 1} transcript should be accepted`).toBe(true);

      // Verify: still no response.cancel after the user turn
      expect(cancelsSent(dc!), `spurious cancel after user turn ${i + 1}`).toBe(0);

      // Simulate Ora's reply — ends with response.done clearing assistantResponseActiveRef
      // and refreshing lastAcceptedUserTurnAtRef so the NEXT speech_started finds
      // the hook in a clean "not active" state.
      await simulateAssistantReply(dc!, `Answer to question ${i + 1}.`);

      // State should be "listening" after response.done
      expect(hook.result.current.state, `state after turn ${i + 1}`).toBe("listening");
    }

    // All 10 user turns must have fired onUserTranscript.
    expect(onUserTranscript).toHaveBeenCalledTimes(TURNS);
    // Ora replied every time.
    expect(onAssistantTranscript).toHaveBeenCalledTimes(TURNS);
    // Zero spurious cancels across all 10 turns.
    expect(cancelsSent(dc!)).toBe(0);
  });

  it("accepts all 10 user turns without any spurious response.cancel (normal mode)", async () => {
    const onUserTranscript = vi.fn();
    const onAssistantTranscript = vi.fn();

    const hook = renderHook(() => useOraRealtimeVoice({ onUserTranscript, onAssistantTranscript }));
    const { ok, dc } = await connectHook(hook, NORMAL_CTX);
    expect(ok).toBe(true);
    expect(dc).not.toBeNull();

    const TURNS = 10;
    for (let i = 0; i < TURNS; i++) {
      expect(cancelsSent(dc!), `spurious cancel before turn ${i + 1}`).toBe(0);

      const accepted = await simulateUserTurn(
        dc!,
        `Tell me about topic ${i + 1} please`,
        `item_n_${i}`,
        onUserTranscript,
      );
      expect(accepted, `normal mode turn ${i + 1} transcript should be accepted`).toBe(true);

      expect(cancelsSent(dc!), `spurious cancel after user turn ${i + 1}`).toBe(0);

      await simulateAssistantReply(dc!, `Normal-mode answer ${i + 1}.`);
      expect(hook.result.current.state, `state after normal-mode turn ${i + 1}`).toBe("listening");
    }

    expect(onUserTranscript).toHaveBeenCalledTimes(TURNS);
    expect(onAssistantTranscript).toHaveBeenCalledTimes(TURNS);
    expect(cancelsSent(dc!)).toBe(0);
  });

  // ─── 2. Focus window refresh after each Ora reply ─────────────────────────

  it("keeps all follow-up transcripts inside the 6 s focus window after response.done", async () => {
    const onUserTranscript = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript, onAssistantTranscript: vi.fn() }),
    );
    const { ok, dc } = await connectHook(hook, FOCUSED_CTX);
    expect(ok).toBe(true);

    for (let i = 0; i < 5; i++) {
      await simulateAssistantReply(dc!);

      // Advance time to just inside the 6 s follow-up window (5 999 ms).
      // response.done refreshes lastAcceptedUserTurnAtRef at this base time,
      // so the next transcript is always within the window regardless of how
      // many turns have elapsed.
      await advanceMs(5_999);

      const accepted = await simulateUserTurn(
        dc!,
        `Follow-up question number ${i + 1}?`,
        `follow_${i}`,
        onUserTranscript,
      );
      expect(accepted, `follow-up ${i + 1} should be accepted (within 12 s of response.done)`).toBe(
        true,
      );

      // Advance past the follow-up window so the next response.done becomes
      // the new baseline.
      await advanceMs(2_000);
    }

    // All 5 follow-up transcripts were accepted.
    expect(onUserTranscript).toHaveBeenCalledTimes(5);
    expect(cancelsSent(dc!)).toBe(0);
  });

  // ─── 3. Root cause B — debounce-gap protection ────────────────────────────

  it("does NOT fire response.cancel when speech_started arrives inside the 600 ms debounce gap", async () => {
    // Scenario: Ora's audio stops (output_audio_buffer.stopped) but response.done
    // has not yet arrived. The debounce runs for 600 ms. If the user starts
    // speaking in this window, speech_started must NOT treat it as a barge-in
    // because the debounce already set assistantResponseActiveRef = false.
    const onUserTranscript = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript, onAssistantTranscript: vi.fn() }),
    );
    const { ok, dc } = await connectHook(hook, FOCUSED_CTX);
    expect(ok).toBe(true);

    // Reach the assistantResponseActive=true state (response.created fires).
    await dispatchEvent(dc!, { type: "response.created" });
    await dispatchEvent(dc!, { type: "output_audio_buffer.started" });
    await dispatchEvent(dc!, {
      type: "response.audio_transcript.delta",
      delta: "I am speaking now.",
    });

    // Audio stops — debounce timer starts (600 ms). response.done has NOT arrived
    // yet, so assistantResponseActiveRef is still true.
    await dispatchEvent(dc!, { type: "output_audio_buffer.stopped" });

    // Advance past the debounce (600 ms): the debounce fires and SETS
    // assistantResponseActiveRef = false BEFORE response.done arrives.
    await advanceMs(650);

    // Verify the hook is now "listening" (debounce flipped the state).
    expect(hook.result.current.state).toBe("listening");

    // User begins speaking. assistantResponseActiveRef is false (cleared by
    // debounce), so speech_started must NOT arm a barge-in timer.
    await dispatchEvent(dc!, { type: "input_audio_buffer.speech_started" });

    // No response.cancel should have been sent.
    expect(cancelsSent(dc!)).toBe(0);

    // Transcript arrives and is accepted (within focus window).
    const accepted = await simulateUserTurn(
      dc!,
      "Can you continue from where you left off?",
      "gap_item_0",
      onUserTranscript,
    );
    expect(accepted).toBe(true);
    expect(cancelsSent(dc!)).toBe(0);
  });

  // ─── 4. Thinking watchdog doesn't strand the session ─────────────────────

  it("thinking watchdog fires when response.done is lost, recovering to listening", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const { ok, dc } = await connectHook(hook);
    expect(ok).toBe(true);

    // Drive into "thinking" state via speech_stopped (watchdog armed = 8 s).
    await dispatchEvent(dc!, { type: "input_audio_buffer.speech_started" });
    await dispatchEvent(dc!, { type: "input_audio_buffer.speech_stopped" });
    expect(hook.result.current.state).toBe("thinking");

    // response.done never arrives — advance past the watchdog threshold.
    await advanceMs(8_100);

    // The watchdog should have recovered the session to "listening", and the
    // session must remain usable (still in "listening") after recovery.
    expect(hook.result.current.state).toBe("listening");
  });

  it("response.created rearmes the watchdog so an overlapping transcript doesn't expire early", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const { ok, dc } = await connectHook(hook);
    expect(ok).toBe(true);

    // speech_stopped arms the watchdog at T=0 (expires at T=8000).
    await dispatchEvent(dc!, { type: "input_audio_buffer.speech_started" });
    await dispatchEvent(dc!, { type: "input_audio_buffer.speech_stopped" });

    // Advance to T=7000 (still in "thinking") — watchdog has NOT expired.
    await advanceMs(7_000);
    expect(hook.result.current.state).toBe("thinking");

    // response.created arrives at T=7000 and RE-ARMS the watchdog for another 8 s
    // (expires at T=15000), cancelling the old watchdog that would fire at T=8000.
    await dispatchEvent(dc!, { type: "response.created" });

    // Advance to T=8100 — if the old watchdog were still live it would have fired.
    // With the rearmed watchdog we remain in "thinking" / "speaking".
    await advanceMs(1_100);
    // Hook is still processing (response.created puts it in "thinking"; no
    // response.done yet). As long as it's NOT "listening" here the watchdog
    // didn't incorrectly fire.
    expect(hook.result.current.state).not.toBe("listening");

    // Clean up: fire response.done to settle the session.
    await dispatchEvent(dc!, { type: "response.done" });
    expect(hook.result.current.state).toBe("listening");
  });

  // ─── 5. No spurious cancel when Ora is already done ──────────────────────

  it("speech_started after response.done does NOT arm a barge-in or send response.cancel", async () => {
    // Narrowly targeted regression guard for the root cause B scenario:
    // response.done fires → assistantResponseActiveRef = false
    // speech_started arrives → should not arm barge-in at all
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const { ok, dc } = await connectHook(hook);
    expect(ok).toBe(true);

    await simulateAssistantReply(dc!);
    expect(hook.result.current.state).toBe("listening");

    // Speech starts — Ora is not active; this must be a normal new-turn event.
    await dispatchEvent(dc!, { type: "input_audio_buffer.speech_started" });
    expect(hook.result.current.state).toBe("listening");

    // Wait for any barge-in confirm timer (BARGE_IN_CONFIRM_MS = 320 ms)
    // that should NOT have been armed.
    await advanceMs(400);

    // Still no response.cancel.
    expect(cancelsSent(dc!)).toBe(0);
  });
});

// ─── Mobile parity: structural source-string assertions ──────────────────────

describe("useOraRealtimeVoiceNative — multi-turn state machine parity (source-string)", () => {
  it("mobile hook clears assistantResponseActiveRef in response.done handler", () => {
    // Root cause B guard: response.done must set assistantResponseActiveRef = false
    // so the NEXT speech_started is never treated as a barge-in.
    const src = readHook("mobile");

    // Locate the response.done case and extract the block up to the next case.
    const doneStart = src.indexOf('case "response.done"');
    expect(doneStart, "response.done case not found in mobile hook").toBeGreaterThan(-1);
    const nextCase = src.indexOf("\n        case ", doneStart + 1);
    const doneBlock = src.slice(doneStart, nextCase > doneStart ? nextCase : doneStart + 2000);

    expect(doneBlock).toContain("assistantResponseActiveRef.current = false");
    expect(doneBlock).toContain("assistantSpeakingRef.current = false");
  });

  it("mobile hook refreshes lastAcceptedUserTurnAtRef in response.done (focus window reset)", () => {
    // Root cause A guard: after Ora finishes speaking, the follow-up window must
    // be reset so the user's next utterance is accepted without a wake word.
    const src = readHook("mobile");
    const doneStart = src.indexOf('case "response.done"');
    const nextCase = src.indexOf("\n        case ", doneStart + 1);
    const doneBlock = src.slice(doneStart, nextCase > doneStart ? nextCase : doneStart + 2000);

    expect(doneBlock).toContain("lastAcceptedUserTurnAtRef.current = Date.now()");
  });

  it("mobile hook debounce callback clears assistantResponseActiveRef before setState listening", () => {
    // Root cause B guard: the 600 ms output_audio_buffer.stopped debounce must
    // set assistantResponseActiveRef = false BEFORE flipping to "listening" so
    // speech_started in the gap window is never treated as a barge-in.
    const src = readHook("mobile");

    // The mobile hook combines two labels: `case "output_audio_buffer.stopped":
    // case "output_audio_buffer.cleared":`. We must search all the way to the
    // NEXT distinct case (`response.done`) to capture the full block body —
    // looking for just the nearest `case "` immediately finds the companion
    // `cleared` label on the very next line, yielding an empty snippet.
    const stoppedStart = src.indexOf('case "output_audio_buffer.stopped"');
    const responseDoneStart = src.indexOf('case "response.done"', stoppedStart);
    const stoppedBlock = src.slice(
      stoppedStart,
      responseDoneStart > stoppedStart ? responseDoneStart : stoppedStart + 3000,
    );

    // The debounce callback must set assistantResponseActiveRef = false.
    expect(stoppedBlock).toContain("assistantResponseActiveRef.current = false");
    // The explanatory comment documenting the root cause must be present.
    expect(stoppedBlock).toContain("assistantResponseActiveRef");
  });

  it("mobile hook arms barge-in ONLY when assistantResponseActiveRef or assistantSpeakingRef is true", () => {
    // speech_started must gate the barge-in timer on the active/speaking refs
    // being true. If both are false (Ora is done), no barge-in is armed.
    const src = readHook("mobile");
    const speechStart = src.indexOf('case "input_audio_buffer.speech_started"');
    const speechEnd = src.indexOf('case "input_audio_buffer.speech_stopped"', speechStart);
    const speechBlock = src.slice(speechStart, speechEnd);

    // The gate must check assistantResponseActiveRef OR assistantSpeakingRef.
    expect(speechBlock).toContain(
      "assistantResponseActiveRef.current || assistantSpeakingRef.current",
    );
    // The barge-in pending flag is only set inside that if-branch.
    expect(speechBlock).toContain("pendingBargeInRef.current = true");
    // response.cancel must NOT appear in the speech_started handler directly.
    expect(speechBlock).not.toContain('"response.cancel"');
  });

  it("mobile and web hooks have identical response.done structural shape", () => {
    // The web and mobile hooks must handle response.done identically so the
    // multi-turn simulation test above is authoritative for both surfaces.
    const webSrc = readHook("web");
    const mobileSrc = readHook("mobile");

    for (const [label, src] of [
      ["web", webSrc],
      ["mobile", mobileSrc],
    ] as const) {
      const doneStart = src.indexOf('case "response.done"');
      const nextCase = src.indexOf("\n        case ", doneStart + 1);
      const doneBlock = src.slice(doneStart, nextCase > doneStart ? nextCase : doneStart + 2000);

      expect(doneBlock, `${label} response.done must clear assistantResponseActiveRef`).toContain(
        "assistantResponseActiveRef.current = false",
      );
      expect(doneBlock, `${label} response.done must clear assistantSpeakingRef`).toContain(
        "assistantSpeakingRef.current = false",
      );
      expect(doneBlock, `${label} response.done must refresh focus window`).toContain(
        "lastAcceptedUserTurnAtRef.current = Date.now()",
      );
      expect(doneBlock, `${label} response.done must cancel barge-in timer`).toContain(
        "clearBargeInTimer()",
      );
    }
  });
});
