/**
 * useOraRealtimeVoice — end-of-turn settle window (turn coalescing).
 *
 * Proves the client waits a short settle window after an accepted turn before
 * asking Ora to reply, so several fragments spoken with mid-thought pauses
 * coalesce into ONE reply instead of Ora answering half a sentence and treating
 * the rest as a new turn.
 *
 * Behavior under test (focused mode, where the client owns response.create):
 *   1. An accepted transcript does NOT immediately send response.create.
 *   2. Exactly one response.create fires after the settle window elapses.
 *   3. Two fragments within the window coalesce into ONE response.create.
 *   4. Resumed speech before the window elapses re-arms (never replies over it).
 *   5. transcription.failed with no accepted turn recovers to listening, no reply.
 *   6. The window length honors the server-provided mint.settleMs.
 *   7. Diagnostics settle_window_scheduled / _rearmed / _fired are emitted.
 *
 * IMPORTANT (see ora-realtime-multi-turn.test.ts):
 *   - RTCPeerConnection mock MUST be a regular function (called with `new`).
 *   - Never runAllTimersAsync() while the duration setInterval is active — use
 *     bounded advanceTimersByTimeAsync(N).
 *   - vi.clearAllMocks() in beforeEach so mock call-counts start at zero.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOraRealtimeVoice, type RealtimeStartContext } from "../use-ora-realtime-voice";
import { extractNamedDeclaration } from "../../../../api-server/src/lib/source-ast-test-helper";

// ─── Source paths (for mobile parity source-string assertions) ─────────────────

// __dirname is artifacts/mustaflow/src/hooks/__tests__ (5 levels below root).
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

class FakeDataChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

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

// No realtimeSessionId so the heartbeat interval is not started (simpler timers).
const MINT_PAYLOAD = {
  value: "ek_test",
  model: "gpt-realtime-mini",
  maxDurationSeconds: 600,
};

function mintResponse(body: Record<string, unknown> = MINT_PAYLOAD) {
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

async function dispatchEvent(dc: FakeDataChannel, event: Record<string, unknown>) {
  await act(async () => {
    dc.onmessage?.({ data: JSON.stringify(event) });
  });
}

/** Count response.create events sent to the data channel. */
function responseCreatesSent(dc: FakeDataChannel): number {
  return (dc.send.mock.calls as [string][]).filter((args) => {
    try {
      return (JSON.parse(args[0]) as { type?: string }).type === "response.create";
    } catch {
      return false;
    }
  }).length;
}

/** Simulate one complete accepted user turn (no timer advance for the settle). */
async function simulateUserTurn(dc: FakeDataChannel, text: string, itemId: string): Promise<void> {
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
}

describe("useOraRealtimeVoice — end-of-turn settle window (turn coalescing)", () => {
  const pcInstances: FakePeerConnection[] = [];
  const diagEvents: string[] = [];

  function FakeRTCPeerConnection(this: FakePeerConnection) {
    const inst = new FakePeerConnection();
    pcInstances.push(inst);
    return inst;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    diagEvents.length = 0;

    // logVoiceDiag emits via console.info("[ora-realtime]", JSON.stringify(...)).
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      if (args[0] === "[ora-realtime]" && typeof args[1] === "string") {
        try {
          const parsed = JSON.parse(args[1]) as { event?: string };
          if (parsed.event) diagEvents.push(parsed.event);
        } catch {
          /* ignore non-JSON console lines */
        }
      }
    });

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

  async function connectHook(
    hook: ReturnType<typeof renderHook<ReturnType<typeof useOraRealtimeVoice>, unknown>>,
    mintBody: Record<string, unknown> = MINT_PAYLOAD,
  ): Promise<FakeDataChannel> {
    vi.mocked(authFetch).mockImplementation(async (url: string) => {
      if (String(url).includes("/session")) return mintResponse(mintBody);
      return okResponse();
    });
    let started = false;
    await act(async () => {
      started = await hook.result.current.start(FOCUSED_CTX);
    });
    expect(started).toBe(true);
    const pc = pcInstances[pcInstances.length - 1];
    await act(async () => {
      // sendEvent only writes when the channel is open (readyState === "open").
      if (pc.dc) pc.dc.readyState = "open";
      pc.dc?.onopen?.();
    });
    return pc.dc!;
  }

  async function advanceMs(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("does NOT send response.create immediately when a turn is accepted", async () => {
    const onUserTranscript = vi.fn();
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript, onAssistantTranscript: vi.fn() }),
    );
    const dc = await connectHook(hook);

    await simulateUserTurn(dc, "What is the capital of France?", "item_0");
    expect(onUserTranscript).toHaveBeenCalledTimes(1);

    // The reply is deferred: no response.create yet, and the UI is listening.
    expect(responseCreatesSent(dc)).toBe(0);
    expect(hook.result.current.state).toBe("listening");
    expect(diagEvents).toContain("settle_window_scheduled");
  });

  it("sends exactly one response.create after the settle window elapses", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const dc = await connectHook(hook);

    await simulateUserTurn(dc, "Tell me a short joke please.", "item_0");
    expect(responseCreatesSent(dc)).toBe(0);

    // Default window is 800 ms; just past it, the settled reply fires once.
    await advanceMs(850);
    expect(responseCreatesSent(dc)).toBe(1);
    expect(hook.result.current.state).toBe("thinking");
    expect(diagEvents).toContain("settle_window_fired");
  });

  it("coalesces two fragments spoken within the window into ONE response.create", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const dc = await connectHook(hook);

    // Fragment 1 — schedules the settle window.
    await simulateUserTurn(dc, "I was thinking about", "item_0");
    // User pauses mid-thought but resumes before the window elapses.
    await advanceMs(400);
    expect(responseCreatesSent(dc)).toBe(0);

    // Fragment 2 — arrives while the window is still pending → re-arm.
    await simulateUserTurn(dc, "planning a trip to Japan next spring.", "item_1");
    expect(responseCreatesSent(dc)).toBe(0);
    expect(diagEvents).toContain("settle_window_rearmed");

    // Only after the (re-armed) window elapses does ONE reply fire.
    await advanceMs(850);
    expect(responseCreatesSent(dc)).toBe(1);
  });

  it("re-arms while the user is still speaking, then fires once they settle", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const dc = await connectHook(hook);

    await simulateUserTurn(dc, "One more thing", "item_0");

    // User starts talking again just before the window elapses.
    await advanceMs(400);
    await dispatchEvent(dc, { type: "input_audio_buffer.speech_started" });

    // Window elapses while speech is active → re-arm, still no reply.
    await advanceMs(850);
    expect(responseCreatesSent(dc)).toBe(0);
    expect(diagEvents).toContain("settle_window_rearmed");

    // User finishes the sentence; the coalesced turn is accepted.
    await dispatchEvent(dc, {
      type: "conversation.item.input_audio_transcription.delta",
      delta: " about the schedule.",
    });
    await dispatchEvent(dc, { type: "input_audio_buffer.speech_stopped" });
    await dispatchEvent(dc, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "One more thing about the schedule.",
      item_id: "item_1",
    });

    await advanceMs(850);
    expect(responseCreatesSent(dc)).toBe(1);
  });

  it("does not reply to a failed transcription and recovers to listening", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    const dc = await connectHook(hook);

    await dispatchEvent(dc, { type: "input_audio_buffer.speech_started" });
    await dispatchEvent(dc, { type: "input_audio_buffer.speech_stopped" });
    await dispatchEvent(dc, {
      type: "conversation.item.input_audio_transcription.failed",
    });

    // No settle scheduled for a broken partial, and no reply is sent.
    await advanceMs(1_200);
    expect(responseCreatesSent(dc)).toBe(0);
    expect(hook.result.current.state).toBe("listening");
  });

  it("honors the server-provided mint.settleMs window length", async () => {
    const hook = renderHook(() =>
      useOraRealtimeVoice({ onUserTranscript: vi.fn(), onAssistantTranscript: vi.fn() }),
    );
    // Server tunes a shorter 300 ms window via the mint.
    const dc = await connectHook(hook, { ...MINT_PAYLOAD, settleMs: 300 });

    await simulateUserTurn(dc, "Quick question for you.", "item_0");

    // Still pending before the 300 ms window.
    await advanceMs(250);
    expect(responseCreatesSent(dc)).toBe(0);

    // Fires after the server-provided window (well before the 800 ms default).
    await advanceMs(100);
    expect(responseCreatesSent(dc)).toBe(1);
  });
});

// ─── Mobile parity: structural source-string assertions ──────────────────────

describe("useOraRealtimeVoiceNative — settle window parity (source-string)", () => {
  it("mobile hook schedules a settled response instead of replying immediately", () => {
    const src = readHook("mobile");
    expect(src).toContain("const scheduleSettledResponse = useCallback(() => {");
    expect(src).toContain("const rearming = settleTimerRef.current !== null;");
    expect(src).toContain("settleTimerRef.current = setTimeout(fire, settleWindowMsRef.current);");
    // The accepted, focused branch defers to the settle window.
    expect(src).toContain("scheduleSettledResponse();");
  });

  it("mobile hook emits all four settle diagnostics", () => {
    const src = readHook("mobile");
    expect(src).toContain('"settle_window_scheduled"');
    expect(src).toContain('"settle_window_rearmed"');
    expect(src).toContain('"settle_window_cancelled"');
    expect(src).toContain('"settle_window_fired"');
  });

  it("mobile hook reads the window length from the mint (server-tunable)", () => {
    const src = readHook("mobile");
    expect(src).toContain("settleWindowMsRef.current =");
    expect(src).toContain('typeof mint.settleMs === "number" && mint.settleMs >= 0');
  });

  it("web and mobile share a byte-identical scheduleSettledResponse body", () => {
    const web = readHook("web").replace(/\r\n/g, "\n");
    const mobile = readHook("mobile").replace(/\r\n/g, "\n");
    const declaration = (src: string): string => {
      const block = extractNamedDeclaration(src, "scheduleSettledResponse", "tsx");
      expect(block).toContain("scheduleSettledResponse = useCallback");
      expect(block).toContain("useCallback");
      return block;
    };
    expect(declaration(mobile)).toBe(declaration(web));
  });
});
