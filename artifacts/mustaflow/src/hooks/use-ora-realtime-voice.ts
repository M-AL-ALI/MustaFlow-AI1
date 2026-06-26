/**
 * useOraRealtimeVoice — TRUE realtime "Talk to Ora" voice over WebRTC.
 *
 * This is the primary "Talk to Ora" path. It opens a live, two-way audio
 * conversation with the OpenAI GA Realtime API directly from the browser:
 *
 *   1. Mint a short-lived ephemeral client secret from our backend
 *      (POST /api/public-ai/realtime/session). The real OPENAI_API_KEY never
 *      reaches the browser — only the single-use `ek_...` token is returned.
 *   2. Capture the mic (getUserMedia), open an RTCPeerConnection, add the mic
 *      track, and create the "oai-events" data channel for transcripts/control.
 *   3. Exchange SDP directly with OpenAI's GA Realtime endpoint
 *      (POST https://api.openai.com/v1/realtime/calls?model=...).
 *   4. Ora's audio arrives on a remote track and plays through a hidden
 *      <audio> element. Transcripts arrive as data-channel events.
 *
 * Design rules:
 *  - This hook owns ONLY the realtime transport + state machine. Transcript
 *    persistence is delegated to callbacks (onUserTranscript /
 *    onAssistantTranscript) so all conversation/quota/memory rules stay in
 *    use-ora-chat. It NEVER calls /chat or /tts.
 *  - Mute silences Ora's audio ONLY (audio element .muted); the mic stays live.
 *  - Interrupt cancels the active response and clears queued output audio.
 *  - A hard duration cap (maxDurationSeconds from the mint) auto-ends the call,
 *    because the server cannot meter audio after the token is issued.
 *  - On any failure that means realtime cannot run (unsupported browser, mic
 *    denied, mint disabled/unavailable, SDP/ICE failure), `fallbackReason` is
 *    set so the caller can drop back to the legacy transcribe -> chat -> tts
 *    loop with a visible warning. Composer mic dictation is untouched.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { authFetch } from "@/lib/api-fetch";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RealtimeVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "unsupported"
  | "permission_denied"
  | "ended";

/** Context forwarded to the mint endpoint so all Ora rules are preserved. */
export interface RealtimeStartContext {
  /** Selected language code (e.g. "en"); omitted when "auto". */
  language?: string;
  /** Optional human-readable language label for the system prompt. */
  languageHint?: string;
  temporary: boolean;
  referenceSavedMemories: boolean;
  oraProjectId?: number | null;
  conversationId?: number | string | null;
  /** Optional recent topic/utterance used ONLY to rank saved-memory recall. */
  message?: string;
  /**
   * A bounded snapshot of the recent text conversation so the spoken session
   * continues with the same context the user already sees. Seeded after the data
   * channel opens as lower-authority realtime conversation items — never sent to
   * the mint or placed in the system instructions.
   */
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface UseOraRealtimeVoiceOptions {
  /** Called once per finalized USER turn (already trimmed). */
  onUserTranscript: (text: string) => void;
  /** Called once per finalized ASSISTANT turn (already trimmed). */
  onAssistantTranscript: (text: string) => void;
  /**
   * Called when realtime drops AFTER a session was already established (e.g. the
   * ICE connection fails mid-call). The initial start() failure is reported via
   * start() resolving false; this covers the late-failure case so the caller can
   * flip to the legacy loop instead of leaving the user stuck in the realtime UI.
   */
  onFallback?: (reason: string) => void;
}

export interface UseOraRealtimeVoiceReturn {
  state: RealtimeVoiceState;
  /** True when this browser can run WebRTC + capture a mic. */
  isSupported: boolean;
  /** Non-null in the "error" state — a short user-facing message. */
  error: string | null;
  /**
   * Non-null when realtime is unavailable and the caller should fall back to the
   * legacy loop. Carries a short reason for the visible warning banner.
   */
  fallbackReason: string | null;
  /** True while Ora's spoken audio is muted (output only; mic stays live). */
  isMuted: boolean;
  /** Live partial transcript of what the user is currently saying. */
  interimUserTranscript: string;
  /** Live partial transcript of what Ora is currently saying. */
  interimAssistantTranscript: string;
  /** Seconds left before the hard duration cap force-ends the call. */
  remainingSeconds: number | null;
  /**
   * Begin a realtime session. Resolves true when connected, false when the
   * session could not start (in which case fallbackReason is set). Must be
   * called from inside a user gesture so audio autoplay is unlocked.
   */
  start: (ctx: RealtimeStartContext) => Promise<boolean>;
  /** End the session and release the mic, peer connection, and audio element. */
  stop: () => void;
  /** Barge-in: cancel Ora's current response and clear queued output audio. */
  interrupt: () => void;
  /** Toggle muting of Ora's spoken audio (does not stop the mic). */
  toggleMute: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MINT_URL = "/api/public-ai/realtime/session";
const DATA_CHANNEL_NAME = "oai-events";
const SDP_TIMEOUT_MS = 15_000;

interface MintResponse {
  value: string;
  expiresAt: number | null;
  model: string;
  voice: string;
  maxDurationSeconds: number;
}

// ─── Feature detection ────────────────────────────────────────────────────────

function detectSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOraRealtimeVoice(
  options: UseOraRealtimeVoiceOptions,
): UseOraRealtimeVoiceReturn {
  const isSupported = detectSupport();

  const [state, setState] = useState<RealtimeVoiceState>(isSupported ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [interimUserTranscript, setInterimUserTranscript] = useState("");
  const [interimAssistantTranscript, setInterimAssistantTranscript] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // Latest callbacks kept in refs so the data-channel handler (registered once
  // per session) always sees the current closures without re-subscribing.
  const onUserRef = useRef(options.onUserTranscript);
  onUserRef.current = options.onUserTranscript;
  const onAssistantRef = useRef(options.onAssistantTranscript);
  onAssistantRef.current = options.onAssistantTranscript;
  const onFallbackRef = useRef(options.onFallback);
  onFallbackRef.current = options.onFallback;

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sdpAbortRef = useRef<AbortController | null>(null);
  // Accumulators for the in-flight turn's final transcript text. The GA API may
  // send the final text either as a single "done" payload or only as deltas, so
  // we accumulate deltas and prefer an explicit final string when present.
  const userTextRef = useRef("");
  const assistantTextRef = useRef("");
  // Guards against double-teardown firing the duration/ICE handlers after stop.
  const activeRef = useRef(false);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    clearDurationTimer();
    sdpAbortRef.current?.abort();
    sdpAbortRef.current = null;

    const dc = dcRef.current;
    if (dc) {
      try {
        dc.onmessage = null;
        dc.onopen = null;
        dc.onclose = null;
        dc.close();
      } catch {
        /* already closed */
      }
      dcRef.current = null;
    }

    const pc = pcRef.current;
    if (pc) {
      try {
        pc.ontrack = null;
        pc.oniceconnectionstatechange = null;
        pc.onconnectionstatechange = null;
        pc.getSenders().forEach((s) => {
          try {
            s.track?.stop();
          } catch {
            /* ignore */
          }
        });
        pc.close();
      } catch {
        /* already closed */
      }
      pcRef.current = null;
    }

    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      streamRef.current = null;
    }

    const audioEl = audioElRef.current;
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
      } catch {
        /* ignore */
      }
      audioElRef.current = null;
    }
  }, [clearDurationTimer]);

  const stop = useCallback(() => {
    if (!activeRef.current && state === "idle") return;
    teardown();
    setInterimUserTranscript("");
    setInterimAssistantTranscript("");
    setRemainingSeconds(null);
    userTextRef.current = "";
    assistantTextRef.current = "";
    setState((s) => (s === "error" || s === "unsupported" ? s : "ended"));
  }, [teardown, state]);

  // Send a control event to the model over the data channel (best-effort).
  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify(event));
      } catch {
        /* best-effort control channel */
      }
    }
  }, []);

  const interrupt = useCallback(() => {
    // Cancel any response the model is currently generating and flush queued
    // output audio so playback stops immediately (WebRTC-specific event).
    sendEvent({ type: "response.cancel" });
    sendEvent({ type: "output_audio_buffer.clear" });
    const audioEl = audioElRef.current;
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
    }
    setInterimAssistantTranscript("");
    assistantTextRef.current = "";
    if (activeRef.current) setState("listening");
  }, [sendEvent]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      const audioEl = audioElRef.current;
      // Output-only: mute Ora's playback. The mic track stays live so Ora keeps
      // hearing the user even while muted (matching the fallback mute control).
      if (audioEl) audioEl.muted = next;
      return next;
    });
  }, []);

  // ── Data-channel event handling ──────────────────────────────────────────
  const handleServerEvent = useCallback((raw: string) => {
    let evt: { type?: string; [k: string]: unknown };
    try {
      evt = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    const type = evt.type;
    if (!type) return;

    switch (type) {
      // ── User speech / input transcription ──────────────────────────────
      case "input_audio_buffer.speech_started":
        // User barged in; the server VAD will interrupt Ora automatically.
        userTextRef.current = "";
        setInterimUserTranscript("");
        if (activeRef.current) setState("listening");
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof evt.delta === "string" ? evt.delta : "";
        if (delta) {
          userTextRef.current += delta;
          setInterimUserTranscript(userTextRef.current);
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const finalText =
          (typeof evt.transcript === "string" && evt.transcript) || userTextRef.current;
        userTextRef.current = "";
        setInterimUserTranscript("");
        if (finalText && finalText.trim()) onUserRef.current(finalText.trim());
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        userTextRef.current = "";
        setInterimUserTranscript("");
        break;

      // ── Assistant response lifecycle ───────────────────────────────────
      case "response.created":
        assistantTextRef.current = "";
        setInterimAssistantTranscript("");
        if (activeRef.current) setState("thinking");
        break;

      // Assistant spoken-transcript deltas. Handle GA names plus older aliases.
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
      case "response.text.delta": {
        const delta = typeof evt.delta === "string" ? evt.delta : "";
        if (delta) {
          assistantTextRef.current += delta;
          setInterimAssistantTranscript(assistantTextRef.current);
          if (activeRef.current) setState("speaking");
        }
        break;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
      case "response.output_text.done":
      case "response.text.done": {
        const finalText =
          (typeof evt.transcript === "string" && evt.transcript) ||
          (typeof evt.text === "string" && evt.text) ||
          assistantTextRef.current;
        if (finalText && finalText.trim()) {
          onAssistantRef.current(finalText.trim());
        }
        assistantTextRef.current = "";
        setInterimAssistantTranscript("");
        break;
      }

      // ── WebRTC output-audio playback markers ───────────────────────────
      case "output_audio_buffer.started": {
        // A prior interrupt() pauses the <audio> element to stop playback
        // immediately. The remote MediaStream is reused across responses, so
        // ontrack never fires again — resume playback here or every reply after
        // an interrupt would be silent. No-op when already playing or muted.
        const audioEl = audioElRef.current;
        if (audioEl && audioEl.paused) {
          void audioEl.play().catch(() => {
            /* autoplay best-effort */
          });
        }
        if (activeRef.current) setState("speaking");
        break;
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (activeRef.current) setState("listening");
        break;

      case "response.done":
        // Flush any assistant text that only arrived via deltas (no explicit
        // done payload) so the turn is never dropped.
        if (assistantTextRef.current.trim()) {
          onAssistantRef.current(assistantTextRef.current.trim());
          assistantTextRef.current = "";
          setInterimAssistantTranscript("");
        }
        if (activeRef.current) setState("listening");
        break;

      case "error": {
        const message =
          (typeof evt.error === "object" &&
            evt.error &&
            typeof (evt.error as { message?: string }).message === "string" &&
            (evt.error as { message?: string }).message) ||
          "";
        // Non-fatal model errors are logged but do not tear the call down; the
        // session can recover on the next turn.
        if (message) {
          // eslint-disable-next-line no-console
          console.warn("[ora-realtime] model error:", message);
        }
        break;
      }
      default:
        break;
    }
  }, []);

  // ── Start ────────────────────────────────────────────────────────────────
  const start = useCallback(
    async (ctx: RealtimeStartContext): Promise<boolean> => {
      if (!isSupported) {
        setState("unsupported");
        setFallbackReason("This browser does not support live voice. Using basic voice mode.");
        return false;
      }
      // Never stack two sessions.
      if (activeRef.current) teardown();

      setError(null);
      setFallbackReason(null);
      setInterimUserTranscript("");
      setInterimAssistantTranscript("");
      userTextRef.current = "";
      assistantTextRef.current = "";
      setIsMuted(false);
      setState("connecting");
      activeRef.current = true;

      // 1) Mint the ephemeral client secret from our backend.
      let mint: MintResponse;
      try {
        const resp = await authFetch(MINT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language: ctx.language,
            languageHint: ctx.languageHint,
            temporary: ctx.temporary,
            referenceSavedMemories: ctx.referenceSavedMemories,
            oraProjectId: ctx.oraProjectId ?? null,
            conversationId: ctx.conversationId ?? null,
            message: ctx.message,
          }),
        });
        if (!resp.ok) {
          let reason = "Live voice is unavailable right now. Using basic voice mode.";
          try {
            const body = (await resp.json()) as { error?: string };
            if (body.error) reason = body.error;
          } catch {
            /* ignore parse failure */
          }
          activeRef.current = false;
          setState("idle");
          setFallbackReason(reason);
          return false;
        }
        mint = (await resp.json()) as MintResponse;
      } catch {
        activeRef.current = false;
        setState("idle");
        setFallbackReason("Could not reach the voice service. Using basic voice mode.");
        return false;
      }

      if (!mint.value) {
        activeRef.current = false;
        setState("idle");
        setFallbackReason("Live voice failed to start. Using basic voice mode.");
        return false;
      }

      // 2) Capture the microphone.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        activeRef.current = false;
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setState("permission_denied");
          setError(
            "Microphone access denied. Allow mic in your browser's address bar, then try again.",
          );
        } else {
          setState("idle");
          setFallbackReason("No microphone available. Using basic voice mode.");
        }
        return false;
      }
      streamRef.current = stream;

      // 3) Build the peer connection.
      try {
        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        // Remote audio sink (hidden, autoplay — unlocked by the start gesture).
        const audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.setAttribute("playsinline", "true");
        audioEl.muted = false;
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        audioElRef.current = audioEl;

        pc.ontrack = (event) => {
          if (event.streams[0]) {
            audioEl.srcObject = event.streams[0];
            void audioEl.play().catch(() => {
              /* autoplay may need the gesture; element is muted=false so OK */
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          const st = pc.iceConnectionState;
          if ((st === "failed" || st === "disconnected") && activeRef.current) {
            const reason = "Live voice connection dropped. Using basic voice mode.";
            teardown();
            setState("idle");
            setFallbackReason(reason);
            // Late failure: start() already resolved true, so the caller is in the
            // realtime UI. Notify it to flip to the legacy loop (the start()-false
            // path cannot cover a mid-call drop).
            onFallbackRef.current?.(reason);
          }
        };

        const micTrack = stream.getAudioTracks()[0];
        if (micTrack) pc.addTrack(micTrack, stream);

        // Data channel for transcripts + control events.
        const dc = pc.createDataChannel(DATA_CHANNEL_NAME);
        dcRef.current = dc;
        dc.onmessage = (e) => handleServerEvent(typeof e.data === "string" ? e.data : "");
        dc.onopen = () => {
          // Seed recent text history as prior conversation items (NOT system
          // instructions). Conversation items are lower-authority context, so
          // user-authored transcript text can never override the voice/system
          // rules or Ora isolation. Items add context only and do not trigger a
          // response (server VAD responds to audio input).
          const history = ctx.history;
          if (history && history.length > 0) {
            for (const turn of history) {
              const text = turn.content.trim().slice(0, 2000);
              if (!text) continue;
              sendEvent({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: turn.role,
                  content: [
                    {
                      type: turn.role === "user" ? "input_text" : "output_text",
                      text,
                    },
                  ],
                },
              });
            }
          }
          if (activeRef.current) setState("listening");
        };

        // 4) Create the offer + exchange SDP with OpenAI directly.
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpAbort = new AbortController();
        sdpAbortRef.current = sdpAbort;
        const sdpTimer = setTimeout(() => sdpAbort.abort(), SDP_TIMEOUT_MS);

        let answerSdp: string;
        try {
          const sdpResp = await fetch(
            `${OPENAI_REALTIME_CALLS_URL}?model=${encodeURIComponent(mint.model)}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${mint.value}`,
                "Content-Type": "application/sdp",
              },
              body: offer.sdp ?? "",
              signal: sdpAbort.signal,
            },
          );
          clearTimeout(sdpTimer);
          if (!sdpResp.ok) {
            throw new Error(`SDP exchange failed (${sdpResp.status})`);
          }
          answerSdp = await sdpResp.text();
        } catch {
          clearTimeout(sdpTimer);
          teardown();
          setState("idle");
          setFallbackReason("Live voice failed to connect. Using basic voice mode.");
          return false;
        }
        sdpAbortRef.current = null;

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        // Duration cap — the server cannot meter audio once the token is live.
        const cap = Math.max(0, Math.floor(mint.maxDurationSeconds || 0));
        if (cap > 0) {
          setRemainingSeconds(cap);
          durationTimerRef.current = setInterval(() => {
            setRemainingSeconds((prev) => {
              if (prev == null) return prev;
              const nextVal = prev - 1;
              if (nextVal <= 0) {
                clearDurationTimer();
                // Auto-end at the cap; not a fallback, just a graceful stop.
                teardown();
                setInterimUserTranscript("");
                setInterimAssistantTranscript("");
                setState("ended");
                return 0;
              }
              return nextVal;
            });
          }, 1000);
        }

        return true;
      } catch {
        teardown();
        setState("idle");
        setFallbackReason("Live voice failed to start. Using basic voice mode.");
        return false;
      }
    },
    [isSupported, teardown, handleServerEvent, clearDurationTimer, sendEvent],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  return {
    state,
    isSupported,
    error,
    fallbackReason,
    isMuted,
    interimUserTranscript,
    interimAssistantTranscript,
    remainingSeconds,
    start,
    stop,
    interrupt,
    toggleMute,
  };
}
