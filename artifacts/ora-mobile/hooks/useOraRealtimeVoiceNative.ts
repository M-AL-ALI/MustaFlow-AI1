/**
 * useOraRealtimeVoiceNative — TRUE realtime "Talk to Ora" voice over WebRTC on
 * native (iOS/Android), the mobile mirror of the website's useOraRealtimeVoice.
 *
 *   1. Mint a short-lived ephemeral client secret from our backend
 *      (POST /api/public-ai/realtime/session via createRealtimeSession). The
 *      real OPENAI_API_KEY never reaches the device — only the `ek_...` token.
 *   2. Capture the mic (mediaDevices.getUserMedia), open an RTCPeerConnection,
 *      add the mic track, and create the "oai-events" data channel.
 *   3. Exchange SDP directly with OpenAI's GA Realtime endpoint
 *      (POST https://api.openai.com/v1/realtime/calls?model=...).
 *   4. Ora's audio arrives on a remote track and plays automatically through the
 *      device (react-native-webrtc routes it to the active output, e.g. AirPods).
 *      Transcripts arrive as data-channel events.
 *
 * Design rules (identical to the web hook):
 *  - Owns ONLY the realtime transport + state machine. Transcript persistence is
 *    delegated to callbacks (onUserTranscript / onAssistantTranscript) so all
 *    conversation/quota/memory rules stay in the screen. It NEVER calls /chat or
 *    /tts.
 *  - Mute silences Ora's audio ONLY (disables the remote track); the mic stays
 *    live so Ora keeps hearing the user.
 *  - Interrupt cancels the active response and clears queued output audio.
 *  - A hard duration cap (maxDurationSeconds from the mint) auto-ends the call,
 *    because the server cannot meter audio after the token is issued.
 *  - Recent text history is seeded client-side as lower-authority
 *    conversation.item.create items on data-channel open — NEVER sent to the mint
 *    or placed in the system instructions (prompt-injection / isolation vector).
 *  - On any failure that means realtime cannot run (native module absent, mic
 *    denied, mint disabled/unavailable, SDP/ICE failure), `fallbackReason` is set
 *    so the caller can drop back to the legacy transcribe -> chat -> tts loop
 *    with a visible warning. Composer mic dictation is untouched.
 *
 * The react-native-webrtc native module only exists in a custom dev/standalone
 * build. In a build without it (e.g. an older client) the package would throw
 * when constructing its NativeEventEmitter, so it is loaded behind a guarded,
 * native-module-checked require and the hook reports `isSupported = false`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules } from "react-native";
import { createRealtimeSession, ApiRequestError } from "@/lib/api";
import type { RealtimeSessionContext } from "@/lib/types";

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

export interface RealtimeStartContext extends RealtimeSessionContext {
  /**
   * A bounded snapshot of the recent text conversation so the spoken session
   * continues with the same context the user already sees. Seeded after the data
   * channel opens as lower-authority realtime conversation items — never sent to
   * the mint or placed in the system instructions.
   */
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface UseOraRealtimeVoiceNativeOptions {
  onUserTranscript: (text: string) => void;
  onAssistantTranscript: (text: string) => void;
  /**
   * Called when realtime drops AFTER a session was established (e.g. ICE fails
   * mid-call). The initial start() failure is reported via start() resolving
   * false; this covers the late-failure case so the caller can flip to the
   * legacy loop instead of leaving the user stuck in the realtime UI.
   */
  onFallback?: (reason: string) => void;
}

export interface UseOraRealtimeVoiceNativeReturn {
  state: RealtimeVoiceState;
  isSupported: boolean;
  error: string | null;
  fallbackReason: string | null;
  isMuted: boolean;
  interimUserTranscript: string;
  interimAssistantTranscript: string;
  remainingSeconds: number | null;
  /**
   * Attempt to start a realtime session. Resolves with `started: true` once the
   * SDP exchange completes, or `started: false` plus a human-readable `reason`
   * the caller can surface as a visible warning before dropping to the legacy
   * voice loop. The reason is returned (not just stored in state) so the caller
   * can read it synchronously after the await.
   */
  start: (ctx: RealtimeStartContext) => Promise<{ started: boolean; reason: string | null }>;
  stop: () => void;
  interrupt: () => void;
  toggleMute: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DATA_CHANNEL_NAME = "oai-events";
const SDP_TIMEOUT_MS = 15_000;

// ─── Voice-stability tuning (mirrored in the website hook) ───────────────────
// Barge-in confirmation: a raw `input_audio_buffer.speech_started` is NOT trusted
// as a real interruption. Ora is only cancelled once the speech is confirmed —
// either it persists for this long OR a genuine (non-filler) transcription delta
// arrives — so Ora never cuts itself off on its own speaker bleed, room noise, or
// echo. 320ms sits inside the 250–350ms window that still feels immediate.
const BARGE_IN_CONFIRM_MS = 320;
// A finalized user transcript must clear this many meaningful characters to count
// as a real turn (clear commands like "stop"/"yes"/"no" bypass it).
const MIN_MEANINGFUL_CHARS = 3;
// A finalized transcript that arrives within this window after Ora's audio AND
// echoes Ora's own recent words is treated as mic echo, not a user turn.
const ECHO_GUARD_MS = 1200;

// ─── Transcript validity filter (mirrored in the website hook) ───────────────
// Pure + surface-agnostic. Keep BYTE-FOR-BYTE identical to the copy in
// artifacts/mustaflow/src/hooks/use-ora-realtime-voice.ts so both surfaces accept
// and reject exactly the same utterances.

/** Short but unambiguous spoken commands that are always accepted. */
const VOICE_COMMANDS = new Set([
  "stop",
  "yes",
  "no",
  "wait",
  "go",
  "continue",
  "repeat",
  "cancel",
  "hi",
  "hello",
  "hey",
]);
/** Isolated filler / noise words rejected when they arrive on their own. */
const FILLER_WORDS = new Set([
  "uh",
  "um",
  "umm",
  "hmm",
  "hmmm",
  "mm",
  "mhm",
  "mhmm",
  "huh",
  "hm",
  "er",
  "erm",
  "ah",
  "oh",
  "you",
  "the",
  "a",
  "an",
  "okay",
  "ok",
  "yeah",
]);

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
function tokenizeTranscript(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter(Boolean);
}
/** True when the user's words are a short subset of Ora's recent speech (echo). */
function isLikelyEcho(userWords: string[], recentAssistantText: string): boolean {
  if (userWords.length === 0 || userWords.length > 6) return false;
  const assistantWords = new Set(tokenizeTranscript(recentAssistantText));
  if (assistantWords.size === 0) return false;
  return userWords.every((w) => assistantWords.has(w));
}

interface TranscriptVerdict {
  accepted: boolean;
  reason?: string;
}

/**
 * Decide whether a finalized user transcript is a real turn or noise. Rejecting
 * here means the turn is never persisted AND can never influence the spoken
 * language (Auto mode only follows accepted turns).
 */
function validateUserTranscript(
  text: string,
  opts: { sinceAssistantAudioMs: number; recentAssistantText: string },
): TranscriptVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { accepted: false, reason: "empty" };
  const words = tokenizeTranscript(trimmed);
  if (words.length === 0) return { accepted: false, reason: "no_words" };
  // Clear single-word commands are always accepted, even though they are short.
  if (words.length === 1 && VOICE_COMMANDS.has(words[0])) return { accepted: true };
  const joined = words.join("");
  if (words.length === 1 && (FILLER_WORDS.has(words[0]) || joined.length <= 2)) {
    return { accepted: false, reason: "filler_or_too_short" };
  }
  if (joined.length < MIN_MEANINGFUL_CHARS) return { accepted: false, reason: "too_short" };
  if (
    opts.sinceAssistantAudioMs <= ECHO_GUARD_MS &&
    opts.recentAssistantText &&
    isLikelyEcho(words, opts.recentAssistantText)
  ) {
    return { accepted: false, reason: "echo" };
  }
  return { accepted: true };
}

/** True once an interim transcript is strong enough to confirm a real barge-in. */
function isPartialSpeechEvidence(interim: string): boolean {
  const words = tokenizeTranscript(interim);
  if (words.length === 0) return false;
  if (words.length === 1 && (FILLER_WORDS.has(words[0]) || words[0].length <= 1)) return false;
  return words.join("").length >= 2;
}

// ─── Speaker-focus filter (mirrored in the website hook) ─────────────────────
// Layered ON TOP of validateUserTranscript and used ONLY in "focused" mode (the
// default). In focused mode the server does not auto-respond, so the client only
// asks Ora to reply for transcripts that clear this filter — which is what keeps
// Ora from answering nearby background speakers. Pure + surface-agnostic: keep
// BYTE-FOR-BYTE identical to the copy in
// artifacts/mustaflow/src/hooks/use-ora-realtime-voice.ts.

export type FocusMode = "normal" | "focused";

// After an accepted turn — or the moment the user opens Talk to Ora, which is an
// explicit address — Ora stays "engaged" for this long. Inside the window,
// follow-ups are accepted naturally in ANY language (no wake word). Outside it,
// speech must be addressed to Ora or be a clear directed command/question, so a
// nearby side conversation no longer makes Ora speak. 12s sits in the 8–15s band.
const FOCUS_WINDOW_MS = 12_000;

// Wake / address tokens that re-open focus after silence or background chatter.
const ORA_ADDRESS_TOKENS = new Set(["ora", "oraa", "orah", "orra", "aura"]);
// Greeting words that, immediately followed by an address token, still address
// Ora ("hey ora", "okay ora", "hello ora").
const ADDRESS_LEAD_WORDS = new Set(["hey", "hi", "hello", "ok", "okay", "yo"]);
// Question / imperative lead words: a transcript starting with one reads as a
// directed request even without a wake word (handles cold-start English turns).
const DIRECT_LEAD_WORDS = new Set([
  "what", "whats", "why", "how", "when", "where", "who", "which", "whose",
  "can", "could", "would", "will", "should", "do", "does", "did", "is", "are",
  "was", "were", "please", "tell", "explain", "show", "give", "help", "make",
  "write", "find", "search", "translate", "summarize", "summarise", "create",
  "read", "open", "list", "define", "describe", "compare", "calculate", "convert",
]);

/** True when the utterance names Ora at the start (a wake / address phrase). */
export function isAddressedToOra(words: string[]): boolean {
  if (words.length === 0) return false;
  if (ORA_ADDRESS_TOKENS.has(words[0])) return true;
  if (words.length >= 2 && ADDRESS_LEAD_WORDS.has(words[0]) && ORA_ADDRESS_TOKENS.has(words[1])) {
    return true;
  }
  return false;
}

/** True when the utterance reads as a directed command or question to Ora. */
export function looksDirected(words: string[], text: string): boolean {
  if (words.length === 0) return false;
  if (text.trim().endsWith("?")) return true;
  if (DIRECT_LEAD_WORDS.has(words[0])) return true;
  return false;
}

/** Address OR directed — used for cold-start acceptance and barge-in gating. */
export function isAddressedOrDirected(text: string): boolean {
  const words = tokenizeTranscript(text);
  return isAddressedToOra(words) || looksDirected(words, text);
}

interface FocusVerdict {
  accepted: boolean;
  reason?: string;
  // True when accepted because the user is inside the active focus window (an
  // engaged follow-up) rather than via an explicit address / directed request.
  viaWindow?: boolean;
}

/**
 * Speaker-focus decision, layered on validateUserTranscript. In "normal" mode it
 * is a pass-through (legacy open listening). In "focused" mode it accepts engaged
 * follow-ups inside the focus window and, outside the window, accepts ONLY clearly
 * addressed or directed speech — never on word count alone, so a real nearby
 * conversation does not trigger Ora.
 */
export function scoreTranscriptFocus(
  text: string,
  opts: {
    focusMode: FocusMode;
    sinceAssistantAudioMs: number;
    recentAssistantText: string;
    msSinceLastAcceptedTurn: number;
  },
): FocusVerdict {
  const base = validateUserTranscript(text, {
    sinceAssistantAudioMs: opts.sinceAssistantAudioMs,
    recentAssistantText: opts.recentAssistantText,
  });
  if (!base.accepted) return { accepted: false, reason: base.reason };
  if (opts.focusMode !== "focused") return { accepted: true };

  const words = tokenizeTranscript(text);
  // Clear single-word commands (stop/yes/no/...) are always addressed.
  if (words.length === 1 && VOICE_COMMANDS.has(words[0])) return { accepted: true };
  // Engaged: inside the focus window accept natural follow-ups in any language.
  if (opts.msSinceLastAcceptedTurn <= FOCUS_WINDOW_MS) return { accepted: true, viaWindow: true };
  // Idle / post-background: require an explicit address or a directed request.
  if (isAddressedToOra(words) || looksDirected(words, text)) return { accepted: true };
  return { accepted: false, reason: "not_addressed_or_outside_focus" };
}

/**
 * Structured, privacy-safe realtime voice diagnostics. Emits event names, counts,
 * reasons, and the selected language — NEVER raw audio or full transcript text —
 * so barge-in / transcript-filter decisions can be inspected in the device log.
 */
function logVoiceDiag(event: string, detail?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.info("[ora-realtime]", JSON.stringify({ event, ...detail }));
}

// ─── Guarded native-module load ─────────────────────────────────────────────

type WebRTCModuleType = typeof import("react-native-webrtc");

let cachedModule: WebRTCModuleType | null = null;
let loadAttempted = false;

function loadWebRTC(): WebRTCModuleType | null {
  if (loadAttempted) return cachedModule;
  loadAttempted = true;
  try {
    // The native side must be present. Requiring the package in a build without
    // the WebRTC native module throws (it builds a NativeEventEmitter from a
    // null module), so check the module exists first, then require behind a
    // try/catch. Metro still bundles the package because the require literal is
    // statically analyzable — only its execution is gated at runtime.
    if (!NativeModules.WebRTCModule) {
      cachedModule = null;
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require("react-native-webrtc") as WebRTCModuleType;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True when this build includes the WebRTC native module and can run realtime. */
export function isRealtimeVoiceNativeAvailable(): boolean {
  return loadWebRTC() != null;
}

// Minimal structural types for the react-native-webrtc objects we touch. The
// package ships its own types, but the event payloads are loosely typed; these
// narrow interfaces keep the hook strict without leaking `any`.
interface RTCTrackLike {
  enabled: boolean;
  stop: () => void;
}
interface MediaStreamLike {
  getAudioTracks: () => RTCTrackLike[];
  getTracks: () => RTCTrackLike[];
}
interface DataChannelLike {
  readyState: string;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => void;
}
interface PeerConnectionLike {
  iceConnectionState: string;
  addTrack: (track: RTCTrackLike, stream: MediaStreamLike) => void;
  createDataChannel: (label: string) => DataChannelLike;
  createOffer: (options?: Record<string, unknown>) => Promise<{ sdp?: string; type: string }>;
  setLocalDescription: (desc: { sdp?: string; type: string }) => Promise<void>;
  setRemoteDescription: (desc: unknown) => Promise<void>;
  addEventListener: (type: string, cb: (event: unknown) => void) => void;
  getReceivers: () => { track?: RTCTrackLike | null }[];
  getSenders: () => { track?: RTCTrackLike | null }[];
  close: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOraRealtimeVoiceNative(
  options: UseOraRealtimeVoiceNativeOptions,
): UseOraRealtimeVoiceNativeReturn {
  const isSupported = isRealtimeVoiceNativeAvailable();

  const [state, setState] = useState<RealtimeVoiceState>(isSupported ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [interimUserTranscript, setInterimUserTranscript] = useState("");
  const [interimAssistantTranscript, setInterimAssistantTranscript] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  const onUserRef = useRef(options.onUserTranscript);
  onUserRef.current = options.onUserTranscript;
  const onAssistantRef = useRef(options.onAssistantTranscript);
  onAssistantRef.current = options.onAssistantTranscript;
  const onFallbackRef = useRef(options.onFallback);
  onFallbackRef.current = options.onFallback;

  const pcRef = useRef<PeerConnectionLike | null>(null);
  const dcRef = useRef<DataChannelLike | null>(null);
  const streamRef = useRef<MediaStreamLike | null>(null);
  const remoteTrackRef = useRef<RTCTrackLike | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sdpAbortRef = useRef<AbortController | null>(null);
  const userTextRef = useRef("");
  const assistantTextRef = useRef("");
  const activeRef = useRef(false);
  // Monotonically increasing session generation. Incremented by teardown() (and
  // captured by each start()) so an in-flight start() can tell whether a rapid
  // stop -> restart has superseded it. activeRef alone is ambiguous: a new start
  // sets it true again, which would let a stale async start() falsely treat
  // itself as current and clobber the shared stream/pc/dc refs.
  const startGenerationRef = useRef(0);
  const mutedRef = useRef(false);

  // ── Barge-in confirmation + transcript-quality guards (mirror of the web hook) ─
  // assistantResponseActiveRef: Ora has a response in flight (response.created ->
  // response.done), even before its first audio frame. assistantSpeakingRef: Ora
  // audio is actually playing. A barge-in is only meaningful while one is true, so
  // checking BOTH catches an interruption in the generation-to-first-audio window.
  const assistantResponseActiveRef = useRef(false);
  const assistantSpeakingRef = useRef(false);
  const pendingBargeInRef = useRef(false);
  const bargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAssistantAudioAtRef = useRef(0);
  const clientCancelledAtRef = useRef(0);
  const recentAssistantSpeechRef = useRef("");
  const selectedLanguageRef = useRef("auto");
  // Speaker-focus state. focusModeRef: the mode chosen at session start ("focused"
  // by default). lastAcceptedUserTurnAtRef: when the user was last clearly engaged
  // (an accepted turn, or the moment Talk to Ora was opened) — drives the focus
  // window inside which follow-ups need no wake word.
  const focusModeRef = useRef<FocusMode>("focused");
  const lastAcceptedUserTurnAtRef = useRef(0);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const clearBargeInTimer = useCallback(() => {
    if (bargeInTimerRef.current) {
      clearTimeout(bargeInTimerRef.current);
      bargeInTimerRef.current = null;
    }
    pendingBargeInRef.current = false;
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    // Invalidate any in-flight start(): its captured generation no longer matches.
    startGenerationRef.current += 1;
    clearDurationTimer();
    clearBargeInTimer();
    assistantResponseActiveRef.current = false;
    assistantSpeakingRef.current = false;
    sdpAbortRef.current?.abort();
    sdpAbortRef.current = null;

    const dc = dcRef.current;
    if (dc) {
      try {
        dc.close();
      } catch {
        /* already closed */
      }
      dcRef.current = null;
    }

    const pc = pcRef.current;
    if (pc) {
      try {
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
    remoteTrackRef.current = null;
  }, [clearDurationTimer, clearBargeInTimer]);

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

  const stopAssistantOutput = useCallback(() => {
    clientCancelledAtRef.current = Date.now();
    sendEvent({ type: "response.cancel" });
    sendEvent({ type: "output_audio_buffer.clear" });
    const track = remoteTrackRef.current;
    if (track) track.enabled = false;
    assistantResponseActiveRef.current = false;
    assistantSpeakingRef.current = false;
    setInterimAssistantTranscript("");
    assistantTextRef.current = "";
  }, [sendEvent]);

  // Outside the focus window in focused mode, a raw sustained-speech timer is NOT
  // enough to interrupt Ora — it is likely a background speaker. In that state a
  // barge-in is confirmed only when the partial transcript is addressed/directed.
  const bargeInGated = useCallback(
    () =>
      focusModeRef.current === "focused" &&
      Date.now() - lastAcceptedUserTurnAtRef.current > FOCUS_WINDOW_MS,
    [],
  );

  // Cancel Ora because a real interruption was CONFIRMED (sustained speech or a
  // genuine transcription delta). This is the ONLY path that stops Ora for a
  // barge-in, so noise / echo / speaker bleed can never cut Ora off mid-sentence.
  const confirmBargeIn = useCallback(
    (reason: string) => {
      if (bargeInTimerRef.current) {
        clearTimeout(bargeInTimerRef.current);
        bargeInTimerRef.current = null;
      }
      if (!pendingBargeInRef.current) return;
      pendingBargeInRef.current = false;
      stopAssistantOutput();
      logVoiceDiag("assistant_cancelled_for_barge_in", { reason });
      if (activeRef.current) setState("listening");
    },
    [stopAssistantOutput],
  );

  // A pending speech_started turned out to be a brief blip (speech_stopped before
  // it could be confirmed). Drop it WITHOUT cancelling Ora.
  const cancelPendingBargeIn = useCallback((reason: string) => {
    if (!pendingBargeInRef.current) return;
    if (bargeInTimerRef.current) {
      clearTimeout(bargeInTimerRef.current);
      bargeInTimerRef.current = null;
    }
    pendingBargeInRef.current = false;
    logVoiceDiag("assistant_cancel_ignored_as_noise", { reason });
  }, []);

  const interrupt = useCallback(() => {
    // Manual interrupt (the user tapped the control). This is always honored —
    // there is no confirmation gate here, unlike the automatic barge-in path.
    clearBargeInTimer();
    stopAssistantOutput();
    if (activeRef.current) setState("listening");
  }, [stopAssistantOutput, clearBargeInTimer]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      // Output-only: disabling the remote track silences Ora's playback while the
      // mic track stays live (Ora keeps hearing the user even while muted).
      const track = remoteTrackRef.current;
      if (track) track.enabled = !next;
      return next;
    });
  }, []);

  // ── Data-channel event handling (identical to the web transport) ──────────
  const handleServerEvent = useCallback(
    (raw: string) => {
      let evt: { type?: string; [k: string]: unknown };
      try {
        evt = JSON.parse(raw) as { type?: string };
      } catch {
        return;
      }
      const type = evt.type;
      if (!type) return;

      switch (type) {
        case "input_audio_buffer.speech_started":
          logVoiceDiag("speech_started", {
            assistantActive: assistantResponseActiveRef.current,
            assistantSpeaking: assistantSpeakingRef.current,
          });
          userTextRef.current = "";
          setInterimUserTranscript("");
          if (assistantResponseActiveRef.current || assistantSpeakingRef.current) {
            // Ora is mid-turn. Do NOT cancel yet: arm a short confirmation timer
            // and wait for proof this is real speech (this timer, or a genuine
            // transcription delta). Brief blips / echo never confirm, so Ora is
            // never cut off by its own audio or by room noise.
            pendingBargeInRef.current = true;
            if (bargeInTimerRef.current) clearTimeout(bargeInTimerRef.current);
            bargeInTimerRef.current = setTimeout(() => {
              bargeInTimerRef.current = null;
              if (
                activeRef.current &&
                pendingBargeInRef.current &&
                (assistantResponseActiveRef.current || assistantSpeakingRef.current)
              ) {
                const directedEnough =
                  !bargeInGated() || isAddressedOrDirected(userTextRef.current);
                if (directedEnough) {
                  confirmBargeIn("sustained_speech");
                } else {
                  // Likely a background speaker while the user is not engaged. Keep
                  // the barge-in pending (a later addressed delta can still confirm
                  // it) but do NOT cut Ora off on sustained speech alone.
                  logVoiceDiag("barge_in_deferred", { reason: "background_outside_focus" });
                }
              } else {
                pendingBargeInRef.current = false;
              }
            }, BARGE_IN_CONFIRM_MS);
          } else if (activeRef.current) {
            // Nothing playing — a normal new user turn.
            setState("listening");
          }
          break;
        case "input_audio_buffer.speech_stopped":
          logVoiceDiag("speech_stopped", { pendingBargeIn: pendingBargeInRef.current });
          if (pendingBargeInRef.current) {
            // Speech ended before it could be confirmed: treat as a noise blip and
            // leave Ora speaking.
            cancelPendingBargeIn("speech_stopped_before_confirm");
          } else if (activeRef.current) {
            setState("thinking");
          }
          break;
        case "conversation.item.input_audio_transcription.delta": {
          const delta = typeof evt.delta === "string" ? evt.delta : "";
          if (delta) {
            userTextRef.current += delta;
            setInterimUserTranscript(userTextRef.current);
            // A genuine (non-filler) partial transcript is strong evidence of a
            // real interruption — confirm immediately so Ora stops fast.
            if (pendingBargeInRef.current && isPartialSpeechEvidence(userTextRef.current)) {
              const directedEnough =
                !bargeInGated() || isAddressedOrDirected(userTextRef.current);
              if (directedEnough) confirmBargeIn("transcript_delta");
            }
          }
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const finalText =
            (typeof evt.transcript === "string" && evt.transcript) || userTextRef.current;
          userTextRef.current = "";
          setInterimUserTranscript("");
          // Gate finalized-transcript persistence on activeRef: a final event can
          // still arrive on the data channel AFTER stop()/teardown() (e.g. the user
          // switched conversation), and persisting it then would append to the new
          // thread's messages — the wrong-thread bug. teardown() sets activeRef
          // false, so a post-teardown event is dropped here.
          if (!activeRef.current) break;
          const trimmed = (finalText || "").trim();
          const focusMode = focusModeRef.current;
          const msSinceLastAcceptedTurn = Date.now() - lastAcceptedUserTurnAtRef.current;
          const verdict = scoreTranscriptFocus(trimmed, {
            focusMode,
            sinceAssistantAudioMs: Date.now() - lastAssistantAudioAtRef.current,
            recentAssistantText: recentAssistantSpeechRef.current,
            msSinceLastAcceptedTurn,
          });
          if (verdict.accepted) {
            // Re-open the focus window: an accepted turn means the user is engaged,
            // so natural follow-ups in any language are accepted for the next
            // FOCUS_WINDOW_MS without a wake word. Only accepted turns are persisted
            // AND only accepted turns may steer the spoken language in Auto mode.
            lastAcceptedUserTurnAtRef.current = Date.now();
            logVoiceDiag("transcript_accepted", {
              chars: trimmed.length,
              focus_mode: focusMode,
              focus_window_active: msSinceLastAcceptedTurn <= FOCUS_WINDOW_MS,
              via_focus_window: verdict.viaWindow === true,
              selected_language: selectedLanguageRef.current,
            });
            onUserRef.current(trimmed);
            // Focused mode: the server does NOT auto-respond (create_response is
            // false), so the client explicitly requests Ora's reply — ONLY here, for
            // an accepted, addressed/engaged turn. Rejected background speech never
            // reaches this line, so Ora stays silent for other speakers.
            if (focusMode === "focused") {
              sendEvent({ type: "response.create" });
            }
          } else {
            logVoiceDiag("transcript_rejected", {
              rejection_reason: verdict.reason,
              chars: trimmed.length,
              focus_mode: focusMode,
              focus_window_active: msSinceLastAcceptedTurn <= FOCUS_WINDOW_MS,
              selected_language: selectedLanguageRef.current,
            });
          }
          break;
        }
        case "conversation.item.input_audio_transcription.failed":
          // In focused mode the client runs the focus filter on the finalized text,
          // so a failed transcription means this turn cannot be scored and gets no
          // reply (logged for support). Rare — input transcription is enabled.
          logVoiceDiag("transcript_failed", { focus_mode: focusModeRef.current });
          userTextRef.current = "";
          setInterimUserTranscript("");
          break;

        case "response.created":
          assistantResponseActiveRef.current = true;
          assistantTextRef.current = "";
          setInterimAssistantTranscript("");
          if (activeRef.current) setState("thinking");
          break;

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta":
        case "response.output_text.delta":
        case "response.text.delta": {
          const delta = typeof evt.delta === "string" ? evt.delta : "";
          if (delta) {
            assistantSpeakingRef.current = true;
            assistantTextRef.current += delta;
            // Keep the echo buffer live: echo guard must compare against what Ora
            // is speaking *right now*, not only the previous finalized turn.
            // Preserved across cancel (stopAssistantOutput never clears it) and
            // time-bounded by ECHO_GUARD_MS in validateUserTranscript.
            recentAssistantSpeechRef.current = assistantTextRef.current;
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
          // See the user-transcript case: gate on activeRef so a late event after
          // teardown can't append Ora's reply to a newly-switched conversation.
          const trimmed = (finalText || "").trim();
          if (activeRef.current && trimmed) {
            // Remember Ora's words so an immediate echoed user transcript can be
            // recognised and rejected.
            recentAssistantSpeechRef.current = trimmed;
            onAssistantRef.current(trimmed);
          }
          assistantTextRef.current = "";
          setInterimAssistantTranscript("");
          break;
        }

        case "output_audio_buffer.started":
          assistantSpeakingRef.current = true;
          lastAssistantAudioAtRef.current = Date.now();
          if (remoteTrackRef.current) remoteTrackRef.current.enabled = !mutedRef.current;
          if (activeRef.current) setState("speaking");
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          assistantSpeakingRef.current = false;
          lastAssistantAudioAtRef.current = Date.now();
          // clientInitiated distinguishes our own confirmed barge-in cancel from a
          // server-driven cancel (e.g. server VAD interrupt_response). A
          // clientInitiated:false clear while Ora was mid-turn means the BACKEND —
          // not noise on the client — cut Ora off.
          logVoiceDiag("output_audio_stopped", {
            type,
            clientInitiated: Date.now() - clientCancelledAtRef.current < 1000,
          });
          if (activeRef.current) setState("listening");
          break;

        case "response.done":
          assistantResponseActiveRef.current = false;
          assistantSpeakingRef.current = false;
          clearBargeInTimer();
          if (assistantTextRef.current.trim()) {
            const trimmed = assistantTextRef.current.trim();
            if (activeRef.current) {
              recentAssistantSpeechRef.current = trimmed;
              onAssistantRef.current(trimmed);
            }
            assistantTextRef.current = "";
            setInterimAssistantTranscript("");
          }
          if (activeRef.current) setState("listening");
          break;

        default:
          break;
      }
    },
    [confirmBargeIn, cancelPendingBargeIn, clearBargeInTimer, bargeInGated, sendEvent],
  );

  // ── Start ────────────────────────────────────────────────────────────────
  const start = useCallback(
    async (ctx: RealtimeStartContext): Promise<{ started: boolean; reason: string | null }> => {
      const mod = loadWebRTC();
      if (!isSupported || !mod) {
        const reason = "Live voice isn't available on this app version. Using basic voice mode.";
        setState("unsupported");
        setFallbackReason(reason);
        return { started: false, reason };
      }
      if (activeRef.current) teardown();

      setError(null);
      setFallbackReason(null);
      setInterimUserTranscript("");
      setInterimAssistantTranscript("");
      userTextRef.current = "";
      assistantTextRef.current = "";
      clearBargeInTimer();
      assistantResponseActiveRef.current = false;
      assistantSpeakingRef.current = false;
      lastAssistantAudioAtRef.current = 0;
      clientCancelledAtRef.current = 0;
      recentAssistantSpeechRef.current = "";
      // Auto mode follows accepted user turns; capture the caller's language choice
      // so rejected (noisy/echo) transcripts can never drift the spoken language.
      selectedLanguageRef.current = ctx.language || "auto";
      // Resolve the speaker-focus posture once, at session start. The caller passes
      // the persisted preference (AsyncStorage); default to "focused".
      const focusMode: FocusMode = ctx.focusMode ?? "focused";
      focusModeRef.current = focusMode;
      // Opening Talk to Ora is an explicit address: seed the focus window so the
      // user's first utterance is treated as engaged (no wake word required).
      lastAcceptedUserTurnAtRef.current = Date.now();
      setIsMuted(false);
      mutedRef.current = false;
      setState("connecting");
      activeRef.current = true;
      // Capture this start()'s generation. teardown() (stop / context switch /
      // background / duration cap / ICE drop / unmount) increments the shared
      // counter, so isCurrent() goes false the instant this attempt is superseded.
      const myGen = ++startGenerationRef.current;
      const isCurrent = () => startGenerationRef.current === myGen;
      // Release ONLY this attempt's own resources. A superseded start must never
      // call the shared teardown() or null the shared refs: a newer session may
      // already own them. Track stop / pc close are idempotent.
      const releaseLocal = (s: MediaStreamLike | null, p: PeerConnectionLike | null) => {
        if (p) {
          try {
            p.close();
          } catch {
            /* already closed */
          }
        }
        if (s) {
          s.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          });
        }
      };

      const { RTCPeerConnection, RTCSessionDescription, mediaDevices } = mod;

      // 1) Mint the ephemeral client secret from our backend.
      let mint;
      try {
        mint = await createRealtimeSession({
          language: ctx.language,
          languageHint: ctx.languageHint,
          temporary: ctx.temporary,
          referenceSavedMemories: ctx.referenceSavedMemories,
          oraProjectId: ctx.oraProjectId ?? null,
          conversationId: ctx.conversationId ?? null,
          message: ctx.message,
          focusMode,
        });
      } catch (err) {
        // Superseded/cancelled while minting: a newer start()/teardown() took
        // over. Nothing is allocated yet, so bail quietly without touching shared
        // state (which a newer session may now own).
        if (!isCurrent()) return { started: false, reason: null };
        activeRef.current = false;
        setState("idle");
        const reason =
          err instanceof ApiRequestError &&
          err.body &&
          typeof (err.body as { error?: string }).error === "string"
            ? (err.body as { error: string }).error
            : "Live voice is unavailable right now. Using basic voice mode.";
        setFallbackReason(reason);
        return { started: false, reason };
      }

      // The user may have left Talk mode / switched context / backgrounded during
      // the mint round-trip. Nothing is allocated yet, so bail quietly (no
      // teardown — a newer session may own the shared state; no fallback warning).
      if (!isCurrent()) return { started: false, reason: null };

      if (!mint.value) {
        activeRef.current = false;
        setState("idle");
        const reason = "Live voice failed to start. Using basic voice mode.";
        setFallbackReason(reason);
        return { started: false, reason };
      }

      // 2) Capture the microphone (iOS prompts via NSMicrophoneUsageDescription).
      let stream: MediaStreamLike;
      try {
        // Echo cancellation / noise suppression / auto gain — the website passes
        // these as getUserMedia audio constraints. react-native-webrtc's typed
        // constraints do NOT expose those web hints; instead it applies its native
        // voice-processing audio unit (hardware AEC/NS/AGC) automatically for an
        // audio capture, so `audio: true` already gives the same processing on the
        // device. (No AirPods-mic guarantee — routing is decided by iOS.)
        stream = (await mediaDevices.getUserMedia({
          audio: true,
          video: false,
        })) as unknown as MediaStreamLike;
      } catch (err) {
        // Superseded/cancelled during the mic prompt: bail quietly.
        if (!isCurrent()) return { started: false, reason: null };
        activeRef.current = false;
        const name = (err as { name?: string } | null)?.name ?? "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          const reason =
            "Microphone access denied. Enable microphone permission in Settings, then try again.";
          setState("permission_denied");
          setError(reason);
          return { started: false, reason };
        }
        const reason = "No microphone available. Using basic voice mode.";
        setState("idle");
        setFallbackReason(reason);
        return { started: false, reason };
      }

      // Superseded/cancelled during the mic-permission prompt: release the mic we
      // just captured directly. It was never assigned to the shared streamRef (a
      // newer session may now own that ref), so clean up the local handle only.
      if (!isCurrent()) {
        releaseLocal(stream, null);
        return { started: false, reason: null };
      }
      streamRef.current = stream;

      // 3) Build the peer connection.
      // pc is declared outside the try so the catch (and supersession checks)
      // can close this attempt's own connection without touching the shared
      // pcRef, which a newer session may already own.
      let pc: PeerConnectionLike | null = null;
      try {
        pc = new RTCPeerConnection({}) as unknown as PeerConnectionLike;
        const activePc = pc;
        pcRef.current = activePc;

        // Remote audio plays automatically through the active output device. Keep
        // a handle on the remote track so mute can disable playback. Re-apply the
        // current mute state in case the user muted before the track arrived.
        activePc.addEventListener("track", (event: unknown) => {
          // A late track event from a superseded peer connection must not
          // overwrite the now-active session's remote track handle.
          if (!isCurrent()) return;
          const e = event as { track?: RTCTrackLike | null };
          if (e.track) {
            remoteTrackRef.current = e.track;
            e.track.enabled = !mutedRef.current;
          }
        });

        activePc.addEventListener("iceconnectionstatechange", () => {
          const st = activePc.iceConnectionState;
          // Only the current generation may flip to the legacy fallback. A stale
          // connection's ICE change must never tear down a newer session.
          if ((st === "failed" || st === "disconnected") && isCurrent() && activeRef.current) {
            const reason = "Live voice connection dropped. Using basic voice mode.";
            teardown();
            setState("idle");
            setFallbackReason(reason);
            onFallbackRef.current?.(reason);
          }
        });

        const micTrack = stream.getAudioTracks()[0];
        if (micTrack) activePc.addTrack(micTrack, stream);

        const dc = activePc.createDataChannel(DATA_CHANNEL_NAME);
        dcRef.current = dc;
        dc.addEventListener("message", (event: { data?: unknown }) => {
          // Drop events from a superseded session's channel so a stale (e.g.
          // late finalized transcript) event can never land in the now-active
          // conversation or flip the now-active session's state.
          if (!isCurrent()) return;
          handleServerEvent(typeof event.data === "string" ? event.data : "");
        });
        dc.addEventListener("open", () => {
          // A superseded channel must not seed history or change state.
          if (!isCurrent()) return;
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
        });

        // 4) Create the offer + exchange SDP with OpenAI directly.
        const offer = await activePc.createOffer();
        await activePc.setLocalDescription(offer);

        // A stop()/restart during offer/setLocalDescription: clean up our own pc
        // + mic and skip the SDP POST so we never create an orphaned call against
        // OpenAI for a session that has already been superseded.
        if (!isCurrent()) {
          releaseLocal(stream, activePc);
          return { started: false, reason: null };
        }

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
          // A stop()/restart aborts the fetch: clean up only our own resources and
          // bail quietly. A genuine failure on the still-current session tears down
          // shared state and warns into the legacy loop.
          if (!isCurrent()) {
            releaseLocal(stream, activePc);
            return { started: false, reason: null };
          }
          teardown();
          setState("idle");
          const reason = "Live voice failed to connect. Using basic voice mode.";
          setFallbackReason(reason);
          return { started: false, reason };
        }
        sdpAbortRef.current = null;

        await activePc.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: answerSdp }),
        );

        // A stop()/restart during the SDP exchange: clean up our own resources and
        // bail instead of arming an orphaned session over a newer one.
        if (!isCurrent()) {
          releaseLocal(stream, activePc);
          return { started: false, reason: null };
        }

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

        return { started: true, reason: null };
      } catch {
        // Unexpected error while building/connecting. If a newer session took
        // over, close only this attempt's own pc + mic; otherwise tear down the
        // shared state and warn into the legacy loop.
        if (!isCurrent()) {
          releaseLocal(stream, pc);
          return { started: false, reason: null };
        }
        teardown();
        setState("idle");
        const reason = "Live voice failed to start. Using basic voice mode.";
        setFallbackReason(reason);
        return { started: false, reason };
      }
    },
    [isSupported, teardown, handleServerEvent, clearDurationTimer, sendEvent, clearBargeInTimer],
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
