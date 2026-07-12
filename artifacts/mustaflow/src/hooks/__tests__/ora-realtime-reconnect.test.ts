/**
 * Talk to Ora realtime voice — reconnect state machine tests (web).
 *
 * Verifies the backoff-ladder auto-reconnect contract for dropped connections:
 *   - An ICE/data-channel drop starts the reconnect ladder (backoff steps
 *     [2 s, 5 s, 10 s...], up to RECONNECT_MAX_ATTEMPTS consecutive attempts).
 *   - A successful reconnect RESETS the ladder, so a later drop reconnects
 *     again — a flaky link keeps recovering for the full session time budget.
 *   - Legacy fallback is entered ONLY after the whole attempt budget is spent
 *     with no success in between; it then sets `fallbackReason`,
 *     `networkQuality` = "legacy", and calls `onFallback` exactly once.
 *   - `retry()` resets the ladder so the user can request a fresh session after
 *     landing in legacy mode.
 *   - The `window.online` event cancels the pending backoff timer and fires the
 *     reconnect immediately.
 *   - A data-channel close/error is treated identically to an ICE failure.
 *
 * No real network, WebRTC, or microphone is used. jsdom + vi fake timers.
 *
 * IMPORTANT: RTCPeerConnection must be mocked as a regular function (not an
 * arrow function) because the hook calls it with `new`. Arrow functions cannot
 * be constructors — using vi.fn(arrowFn) throws a TypeError inside the hook's
 * outer try-catch, causing start() to silently return false.
 *
 * IMPORTANT: vi.clearAllMocks() is required in beforeEach so mock call-counts
 * start at zero for each test. Without it, counts from earlier tests accumulate
 * and break assertions about how many mints were issued.
 *
 * IMPORTANT: Never call vi.runAllTimersAsync() when setInterval timers are
 * active (duration countdown, heartbeat). That API runs until the queue is
 * empty — intervals never empty it, triggering the "10000 timers" abort guard.
 * Use vi.advanceTimersByTimeAsync(N) with a bounded N instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOraRealtimeVoice, type RealtimeStartContext } from "../use-ora-realtime-voice";

// ─── Mock @/lib/api-fetch ─────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by vitest; the import below
// receives the mocked version automatically.

vi.mock("@/lib/api-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/api-fetch";

// ─── Fake WebRTC primitives ───────────────────────────────────────────────────

/** Stand-in for RTCDataChannel. The hook assigns onopen/onclose/onerror as
 *  plain properties; storing them here lets tests call them directly. */
class FakeDataChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

/** Stand-in for RTCPeerConnection. Captures the handlers the hook sets and
 *  exposes `simulate*` helpers to trigger state-machine transitions. */
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

  simulateIceFailed() {
    this.iceConnectionState = "failed";
    this.oniceconnectionstatechange?.();
  }
  simulatePcFailed() {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
  simulateDcClose() {
    this.dc?.onclose?.();
  }
  simulateDcError() {
    this.dc?.onerror?.();
  }
}

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const DEFAULT_CTX: RealtimeStartContext = {
  temporary: false,
  referenceSavedMemories: false,
};

const MINT_PAYLOAD = {
  value: "ek_test",
  model: "gpt-realtime-mini",
  maxDurationSeconds: 600,
  realtimeSessionId: "sess_001",
  // No heartbeatIntervalSeconds → defaults to 30 s in the hook.
  // Advancing timers by ≤ 5 s will never fire the heartbeat interval.
};

function mintResponse(body = MINT_PAYLOAD) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function mintErrorResponse(status = 503) {
  return new Response(JSON.stringify({ error: "unavailable" }), { status });
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

// Total virtual time to exhaust the whole reconnect ladder. The backoff steps are
// [2 s, 5 s, 10 s, 10 s, 10 s, 10 s] for RECONNECT_MAX_ATTEMPTS = 6 (~47 s of
// consecutive failures). Advance a little past that so the final attempt fails and
// the legacy fallback is entered.
const FULL_LADDER_MS = 50_000;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("useOraRealtimeVoice — reconnect state machine", () => {
  /** All FakePeerConnection instances created during a test (in construction order). */
  const pcInstances: FakePeerConnection[] = [];

  /**
   * RTCPeerConnection constructor mock — MUST be a regular `function` (not
   * an arrow function) because the hook calls `new RTCPeerConnection()`.
   * Arrow functions throw when used as constructors.
   * Returning an object from a `new` call substitutes it for `this`.
   */
  function FakeRTCPeerConnection(this: FakePeerConnection) {
    const inst = new FakePeerConnection();
    pcInstances.push(inst);
    return inst;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset mock call history so each test starts from zero.
    vi.clearAllMocks();

    // WebRTC feature-detection in the hook checks isSecureContext.
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      writable: true,
      configurable: true,
    });

    // Register the fake constructor BEFORE renderHook so detectSupport() passes.
    pcInstances.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).RTCPeerConnection = FakeRTCPeerConnection;

    // getUserMedia always succeeds with a fake stream.
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) },
      writable: true,
      configurable: true,
    });

    // authFetch: MINT endpoint → ok; heartbeat/end beacons → 200.
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintResponse();
      return okResponse();
    });

    // global fetch: SDP exchange with OpenAI → ok.
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

  // ─── Helper: bring the hook to a fully-connected "listening" state ──────

  /**
   * Starts the hook and fires dc.onopen so state reaches "listening".
   * Returns true when start() succeeded (an RTCPeerConnection was created).
   */
  async function connectHook(
    hook: ReturnType<typeof renderHook<ReturnType<typeof useOraRealtimeVoice>, unknown>>,
  ): Promise<boolean> {
    let started = false;
    await act(async () => {
      started = await hook.result.current.start(DEFAULT_CTX);
    });
    if (!started) return false;
    const lastPc = pcInstances[pcInstances.length - 1];
    await act(async () => {
      lastPc.dc?.onopen?.();
    });
    return true;
  }

  /** Advance fake timers by N ms while flushing promises between ticks. */
  async function advanceMs(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // ─── Baseline ────────────────────────────────────────────────────────────

  it("starts successfully and reaches 'listening' with networkQuality 'good'", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );

    const ok = await connectHook(hook);

    expect(ok).toBe(true);
    expect(hook.result.current.state).toBe("listening");
    expect(hook.result.current.networkQuality).toBe("good");
    expect(hook.result.current.fallbackReason).toBeNull();
    expect(hook.result.current.error).toBeNull();
  });

  // ─── Single auto-reconnect on first ICE drop ──────────────────────────────

  it("schedules a reconnect on first ICE drop — networkQuality becomes 'reconnecting'", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    act(() => {
      pcInstances[0].simulateIceFailed();
    });

    // While the 2 s timer is pending the quality must be "reconnecting".
    expect(hook.result.current.networkQuality).toBe("reconnecting");
    // fallbackReason must be null — we have not given up yet.
    expect(hook.result.current.fallbackReason).toBeNull();
  });

  it("fires exactly ONE mint for the auto-reconnect after the first backoff step (2 s) elapses", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    const mintsAfterConnect = vi
      .mocked(authFetch)
      .mock.calls.filter((a) => String(a[0]).includes("/session")).length;
    expect(mintsAfterConnect).toBe(1);

    act(() => {
      pcInstances[0].simulateIceFailed();
    });

    // Advance past the first backoff step (RECONNECT_BACKOFF_MS[0] = 2000 ms).
    await advanceMs(2500);

    const mintsAfterReconnect = vi
      .mocked(authFetch)
      .mock.calls.filter((a) => String(a[0]).includes("/session")).length;
    // Exactly one more mint for the auto-reconnect.
    expect(mintsAfterReconnect).toBe(2);
    // Quality should be "good" once the reconnect succeeded.
    expect(hook.result.current.networkQuality).toBe("good");
    expect(hook.result.current.fallbackReason).toBeNull();
  });

  // ─── Legacy fallback when the reconnect itself fails ─────────────────────

  it("enters legacy fallback only after the whole reconnect ladder is exhausted", async () => {
    const onFallback = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoice({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
        onFallback,
      }),
    );
    await connectHook(hook);

    // After the initial connect succeeds, make every subsequent mint fail so no
    // reconnect attempt can ever land.
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintErrorResponse();
      return okResponse();
    });

    act(() => {
      pcInstances[0].simulateIceFailed();
    });

    // A single failed attempt must NOT drop to legacy — the ladder keeps retrying
    // so a flaky link can recover for the full session time budget.
    await advanceMs(2500);
    expect(hook.result.current.networkQuality).toBe("reconnecting");
    expect(onFallback).not.toHaveBeenCalled();

    // Advance past the full backoff ladder so every consecutive attempt fails and
    // the budget (RECONNECT_MAX_ATTEMPTS) is finally spent.
    await advanceMs(FULL_LADDER_MS);

    expect(hook.result.current.networkQuality).toBe("legacy");
    expect(hook.result.current.fallbackReason).toMatch(/reconnect failed|basic voice/i);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  // ─── Ladder resets on a successful reconnect ──────────────────────────────

  it("a second drop after a successful reconnect schedules another reconnect (ladder resets on success)", async () => {
    const onFallback = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoice({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
        onFallback,
      }),
    );
    await connectHook(hook);

    // First drop → the ladder schedules a reconnect.
    act(() => {
      pcInstances[0].simulateIceFailed();
    });
    expect(hook.result.current.networkQuality).toBe("reconnecting");

    // Fire the first backoff step (2 s) — the reconnect session starts and
    // succeeds, which RESETS the ladder.
    await advanceMs(2500);
    expect(pcInstances).toHaveLength(2);
    expect(hook.result.current.networkQuality).toBe("good");

    // Open the data channel on the reconnected session.
    await act(async () => {
      pcInstances[1].dc?.onopen?.();
    });

    // Second drop on the reconnected session must schedule ANOTHER reconnect —
    // NOT drop to legacy — because the successful reconnect reset the budget.
    act(() => {
      pcInstances[1].simulateIceFailed();
    });
    expect(hook.result.current.networkQuality).toBe("reconnecting");
    expect(hook.result.current.fallbackReason).toBeNull();
    expect(onFallback).not.toHaveBeenCalled();

    // And it, too, recovers on the first backoff step.
    await advanceMs(2500);
    expect(pcInstances).toHaveLength(3);
    expect(hook.result.current.networkQuality).toBe("good");
  });

  it("each drop after a successful reconnect fires another mint (ladder resets on success)", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    // First drop + auto-reconnect succeeds → 2 mints total.
    act(() => {
      pcInstances[0].simulateIceFailed();
    });
    await advanceMs(2500);

    const mintsAfterFirstReconnect = vi
      .mocked(authFetch)
      .mock.calls.filter((a) => String(a[0]).includes("/session")).length;
    expect(mintsAfterFirstReconnect).toBe(2);

    // Open the reconnected data channel, then drop again.
    await act(async () => {
      pcInstances[1].dc?.onopen?.();
    });
    act(() => {
      pcInstances[1].simulateIceFailed();
    });
    await advanceMs(2500);

    const mintsAfterSecondReconnect = vi
      .mocked(authFetch)
      .mock.calls.filter((a) => String(a[0]).includes("/session")).length;
    // The reset ladder fired a third mint for the second recovery.
    expect(mintsAfterSecondReconnect).toBe(3);
  });

  // ─── Alternative drop sources ─────────────────────────────────────────────

  it("handles RTCPeerConnection.connectionState 'failed' the same as an ICE failure", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    act(() => {
      pcInstances[0].simulatePcFailed();
    });

    // Should schedule a reconnect on the first pc_failed event.
    expect(hook.result.current.networkQuality).toBe("reconnecting");

    await advanceMs(2500);
    expect(hook.result.current.networkQuality).toBe("good");
  });

  it("treats a data-channel 'close' as a connection drop — auto-reconnect fires", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    act(() => {
      pcInstances[0].simulateDcClose();
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
  });

  it("treats a data-channel 'error' as a connection drop — auto-reconnect fires", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    act(() => {
      pcInstances[0].simulateDcError();
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
  });

  // ─── retry() after legacy fallback ───────────────────────────────────────

  it("retry() clears fallbackReason and starts a fresh session", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    // Drive the hook into legacy fallback by exhausting the reconnect ladder
    // (every mint fails, so no attempt can land).
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintErrorResponse();
      return okResponse();
    });

    act(() => {
      pcInstances[0].simulateIceFailed();
    });
    await advanceMs(FULL_LADDER_MS);

    expect(hook.result.current.networkQuality).toBe("legacy");
    expect(hook.result.current.fallbackReason).toBeTruthy();

    // Reset mock so the retry-triggered start() succeeds.
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintResponse();
      return okResponse();
    });

    // retry() is synchronous but fires a void async chain; advance a small
    // bounded amount to flush it without triggering the interval infinite loop.
    await act(async () => {
      hook.result.current.retry();
      await vi.advanceTimersByTimeAsync(200);
    });

    // The retry should clear the fallback state and restore quality.
    expect(hook.result.current.fallbackReason).toBeNull();
    expect(hook.result.current.networkQuality).toBe("good");
  });

  it("retry() resets the reconnect budget — a future drop auto-reconnects once more", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    // Reach legacy by exhausting the reconnect ladder (every mint fails).
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintErrorResponse();
      return okResponse();
    });
    act(() => {
      pcInstances[0].simulateIceFailed();
    });
    await advanceMs(FULL_LADDER_MS);
    expect(hook.result.current.networkQuality).toBe("legacy");

    // Retry with a working mint — reconnect budget is reset by retry().
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintResponse();
      return okResponse();
    });
    await act(async () => {
      hook.result.current.retry();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(hook.result.current.networkQuality).toBe("good");

    // A drop on the retried session should again schedule ONE auto-reconnect.
    const lastPc = pcInstances[pcInstances.length - 1];
    act(() => {
      lastPc.simulateIceFailed();
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
  });

  // ─── window.online accelerated reconnect ─────────────────────────────────

  it("window.online event cancels the pending timer and fires reconnect immediately", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    await connectHook(hook);

    const mintsBeforeDrop = vi
      .mocked(authFetch)
      .mock.calls.filter((a) => String(a[0]).includes("/session")).length;

    // Drop the connection — the 2 s reconnect timer starts.
    act(() => {
      pcInstances[0].simulateIceFailed();
    });
    expect(hook.result.current.networkQuality).toBe("reconnecting");

    // Fire the browser online event BEFORE the 2 s timer expires.
    // Use a small advanceTimersByTimeAsync to flush the resulting start() promise.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });

    const mintsAfterOnline = vi
      .mocked(authFetch)
      .mock.calls.filter((a) => String(a[0]).includes("/session")).length;
    // A second mint should have fired (reconnect triggered immediately by online).
    expect(mintsAfterOnline).toBeGreaterThan(mintsBeforeDrop);
  });
});
