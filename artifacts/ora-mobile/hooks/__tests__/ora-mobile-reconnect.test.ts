/**
 * Mobile reconnect state machine — useOraRealtimeVoiceNative
 *
 * Covers the single-attempt auto-reconnect / legacy-fallback path.
 * Two behaviors are mobile-specific:
 *  1. WebRTC events use addEventListener() (EventTarget style, from
 *     react-native-webrtc), not onXxx properties.
 *  2. Network-recovery is driven by NetInfo.addEventListener(), not the
 *     browser's window.online event.
 *
 * Run with:
 *   pnpm --filter @workspace/ora-mobile exec vitest run --config vitest.config.hooks.ts
 *
 * Implementation note:
 *  loadWebRTC() uses CJS require("react-native-webrtc") which fails in the
 *  Vite/jsdom ESM environment.  The exported _setWebRTCModuleForTest /
 *  _resetWebRTCCacheForTest seam bypasses the guarded require entirely.
 */

import { vi, beforeEach, afterEach, describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useOraRealtimeVoiceNative,
  _setWebRTCModuleForTest,
  _resetWebRTCCacheForTest,
} from "../useOraRealtimeVoiceNative";
import { createRealtimeSession } from "@/lib/api";

const RECONNECT_DELAY_MS = 2_000;

// Total virtual time to exhaust the whole reconnect ladder. The backoff steps are
// [2 s, 5 s, 10 s, 10 s, 10 s, 10 s] for RECONNECT_MAX_ATTEMPTS = 6 (~47 s of
// consecutive failures). Advance a little past that so the final attempt fails and
// the legacy fallback is entered.
const FULL_LADDER_MS = 50_000;

// ─── Fake EventEmitter (EventTarget-style, used by react-native-webrtc) ───────

class FakeEmitter {
  private _listeners: Map<string, Array<(e?: unknown) => void>> = new Map();

  addEventListener(type: string, cb: (e?: unknown) => void) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(cb);
  }

  dispatch(type: string, event?: unknown) {
    (this._listeners.get(type) ?? []).forEach((cb) => cb(event));
  }
}

// ─── Fake RTCPeerConnection & DataChannel ────────────────────────────────────

class FakePCMobile extends FakeEmitter {
  iceConnectionState: string = "new";
  connectionState: string = "new";
  private _dc: FakeDCMobile | null = null;

  addTrack() {}

  createDataChannel(_name: string) {
    this._dc = new FakeDCMobile();
    return this._dc;
  }

  get dc() {
    return this._dc;
  }

  async createOffer() {
    return { sdp: "v=0\r\n", type: "offer" };
  }

  async setLocalDescription(_d: unknown) {}

  async setRemoteDescription(_d: unknown) {}

  close() {}
}

class FakeDCMobile extends FakeEmitter {
  readyState: string = "connecting";
  send(_data: unknown) {}
  close() {}
}

// ─── Collections reset per test ───────────────────────────────────────────────

const pcInstances: FakePCMobile[] = [];
let netInfoCallback: ((state: unknown) => void) | null = null;

// ─── Fake WebRTC module injected via test-seam ───────────────────────────────

function FakeRTCPC(this: FakePCMobile) {
  const inst = new FakePCMobile();
  pcInstances.push(inst);
  return inst;
}
function FakeRTCSD(this: unknown, _d: unknown) {}

const fakeWebRTCModule = {
  RTCPeerConnection: FakeRTCPC as unknown,
  RTCSessionDescription: FakeRTCSD as unknown,
  mediaDevices: {
    getUserMedia: vi.fn(async () => ({
      getAudioTracks: () => [{ enabled: true, stop: vi.fn() }],
      getTracks: () => [{ stop: vi.fn() }],
    })),
  },
};

// ─── Static mocks ─────────────────────────────────────────────────────────────

vi.mock("react-native", () => ({
  NativeModules: { WebRTCModule: { name: "WebRTCModule" } },
}));

vi.mock("react-native-webrtc", () => ({
  RTCPeerConnection: class {},
  RTCSessionDescription: class {},
  mediaDevices: { getUserMedia: vi.fn() },
}));

vi.mock("@react-native-community/netinfo", () => ({
  default: {
    addEventListener: vi.fn((cb: (state: unknown) => void) => {
      netInfoCallback = cb;
      return () => {
        netInfoCallback = null;
      };
    }),
  },
}));

vi.mock("expo-audio", () => ({
  setAudioModeAsync: vi.fn(async () => {}),
}));

vi.mock("@/lib/api", () => {
  class ApiRequestError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, msg: string, body?: unknown) {
      super(msg);
      this.name = "ApiRequestError";
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiRequestError,
    createRealtimeSession: vi.fn(),
    endRealtimeSession: vi.fn(async () => {}),
    heartbeatRealtimeSession: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("@workspace/ora-contracts", () => ({
  OPENAI_REALTIME_CALLS_URL: "https://api.openai.com/v1/realtime/calls",
}));

// ─── SDP stub ─────────────────────────────────────────────────────────────────

const sdpResponse = () =>
  new Response("v=0\r\nremote-answer-sdp", {
    status: 200,
    headers: { "Content-Type": "application/sdp" },
  });

const mintOk = { value: "ek_test_token", model: "gpt-realtime-mini", expiresAt: null };

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  pcInstances.length = 0;
  netInfoCallback = null;

  // Inject the fake WebRTC module via the test-seam, bypassing loadWebRTC()'s
  // guarded require() which fails in the Vite/ESM jsdom test environment.
  _resetWebRTCCacheForTest();
  _setWebRTCModuleForTest(fakeWebRTCModule as never);

  vi.mocked(createRealtimeSession).mockResolvedValue(mintOk as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sdpResponse()),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetWebRTCCacheForTest();
});

// ─── Helper: start a hook and drive it to "listening" ────────────────────────

async function connectHook(
  hook: ReturnType<typeof renderHook<ReturnType<typeof useOraRealtimeVoiceNative>, never>>,
) {
  const ctx = {
    temporary: false,
    referenceSavedMemories: false,
    language: "en",
    message: "Hello",
    focusMode: "focused" as const,
    voicePreset: "marine" as const,
  };
  let startPromise: ReturnType<typeof hook.result.current.start>;
  await act(async () => {
    startPromise = hook.result.current.start(ctx);
    await vi.advanceTimersByTimeAsync(0);
  });
  // Drive the data-channel to open state so the hook transitions to "listening".
  const pc = pcInstances[pcInstances.length - 1];
  if (pc) {
    await act(async () => {
      pc.dc?.dispatch("open");
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  await act(async () => {
    await startPromise;
  });
  return pc;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useOraRealtimeVoiceNative — reconnect state machine", () => {
  it("starts successfully and reaches 'listening' with networkQuality 'good'", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);

    expect(hook.result.current.state).toBe("listening");
    expect(hook.result.current.networkQuality).toBe("good");
    expect(hook.result.current.fallbackReason).toBeNull();
  });

  it("schedules a reconnect on first ICE drop — networkQuality becomes 'reconnecting'", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);
    const pc = pcInstances[0];
    pc.iceConnectionState = "disconnected";

    await act(async () => {
      pc.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
    expect(hook.result.current.fallbackReason).toBeNull();
  });

  it("fires exactly ONE mint for the auto-reconnect after RECONNECT_DELAY_MS elapses", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);
    expect(vi.mocked(createRealtimeSession)).toHaveBeenCalledTimes(1);

    const pc = pcInstances[0];
    pc.iceConnectionState = "disconnected";
    await act(async () => {
      pc.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS + 100);
      const pc2 = pcInstances[1];
      if (pc2) {
        pc2.dc?.dispatch("open");
        await vi.advanceTimersByTimeAsync(0);
      }
    });

    expect(vi.mocked(createRealtimeSession)).toHaveBeenCalledTimes(2);
    expect(hook.result.current.networkQuality).toBe("good");
  });

  it("enters legacy fallback only after the whole reconnect ladder is exhausted", async () => {
    const onFallback = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
        onFallback,
      }),
    );

    await connectHook(hook);

    // Every subsequent mint fails, so no reconnect attempt can ever land.
    vi.mocked(createRealtimeSession).mockRejectedValue(new Error("network error"));

    const pc = pcInstances[0];
    pc.iceConnectionState = "failed";
    await act(async () => {
      pc.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });

    // A single failed attempt must NOT drop to legacy — the ladder keeps retrying
    // so a flaky link can recover for the full session time budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS + 500);
    });
    expect(hook.result.current.networkQuality).toBe("reconnecting");
    expect(onFallback).not.toHaveBeenCalled();

    // Advance past the full backoff ladder so every consecutive attempt fails and
    // the budget (RECONNECT_MAX_ATTEMPTS) is finally spent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FULL_LADDER_MS);
    });

    expect(hook.result.current.networkQuality).toBe("legacy");
    expect(hook.result.current.fallbackReason).toBeTruthy();
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("a second drop after a successful reconnect schedules another reconnect (ladder resets on success)", async () => {
    const onFallback = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
        onFallback,
      }),
    );

    await connectHook(hook);
    const pc = pcInstances[0];

    // First drop → schedules a reconnect.
    pc.iceConnectionState = "disconnected";
    await act(async () => {
      pc.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.networkQuality).toBe("reconnecting");

    // Fire the first backoff step — the reconnect session starts and succeeds,
    // which RESETS the ladder.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS + 100);
      pcInstances[1]?.dc?.dispatch("open");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pcInstances).toHaveLength(2);
    expect(hook.result.current.networkQuality).toBe("good");

    // Second drop on the reconnected session must schedule ANOTHER reconnect —
    // NOT drop to legacy — because the successful reconnect reset the budget.
    const pc2 = pcInstances[1];
    pc2.iceConnectionState = "disconnected";
    await act(async () => {
      pc2.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.networkQuality).toBe("reconnecting");
    expect(hook.result.current.fallbackReason).toBeNull();
    expect(onFallback).not.toHaveBeenCalled();

    // And it, too, recovers on the first backoff step.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS + 100);
      pcInstances[2]?.dc?.dispatch("open");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pcInstances).toHaveLength(3);
    expect(hook.result.current.networkQuality).toBe("good");
  });

  it("handles RTCPeerConnection.connectionState 'failed' the same as ICE failure", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);
    const pc = pcInstances[0];
    pc.connectionState = "failed";

    await act(async () => {
      pc.dispatch("connectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
  });

  it("treats a data-channel 'close' as a connection drop — auto-reconnect fires", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);
    const pc = pcInstances[0];

    await act(async () => {
      pc.dc?.dispatch("close");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
  });

  it("treats a data-channel 'error' as a connection drop — auto-reconnect fires", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);
    const pc = pcInstances[0];

    await act(async () => {
      pc.dc?.dispatch("error");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
  });

  it("NetInfo connectivity event cancels the pending timer and fires reconnect immediately", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);
    expect(netInfoCallback).not.toBeNull();

    const pc = pcInstances[0];
    pc.iceConnectionState = "disconnected";
    await act(async () => {
      pc.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.networkQuality).toBe("reconnecting");
    expect(vi.mocked(createRealtimeSession)).toHaveBeenCalledTimes(1);

    // NetInfo fires → should clear the timer and reconnect immediately
    await act(async () => {
      netInfoCallback?.({ isConnected: true, isInternetReachable: true });
      await vi.advanceTimersByTimeAsync(200);
      const pc2 = pcInstances[1];
      if (pc2) {
        pc2.dc?.dispatch("open");
        await vi.advanceTimersByTimeAsync(0);
      }
    });

    expect(vi.mocked(createRealtimeSession)).toHaveBeenCalledTimes(2);
    expect(hook.result.current.networkQuality).toBe("good");
  });

  it("NetInfo event does NOT fire reconnect a second time (one-shot latch)", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoiceNative({
        onUserTranscript: vi.fn(),
        onAssistantTranscript: vi.fn(),
      }),
    );

    await connectHook(hook);

    const pc = pcInstances[0];
    pc.iceConnectionState = "disconnected";
    await act(async () => {
      pc.dispatch("iceconnectionstatechange");
      await vi.advanceTimersByTimeAsync(0);
    });

    // First NetInfo trigger → reconnect
    await act(async () => {
      netInfoCallback?.({ isConnected: true, isInternetReachable: true });
      await vi.advanceTimersByTimeAsync(200);
      const pc2 = pcInstances[1];
      if (pc2) {
        pc2.dc?.dispatch("open");
        await vi.advanceTimersByTimeAsync(0);
      }
    });

    const mintCountAfterFirst = vi.mocked(createRealtimeSession).mock.calls.length;

    // Second NetInfo trigger → must NOT reconnect again (one-shot latch)
    await act(async () => {
      netInfoCallback?.({ isConnected: true, isInternetReachable: true });
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(vi.mocked(createRealtimeSession)).toHaveBeenCalledTimes(mintCountAfterFirst);
  });
});
