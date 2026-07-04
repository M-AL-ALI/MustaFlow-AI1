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
 *   4. Ora's audio arrives on a remote track. The session category is set to
 *      playAndRecord via setAudioModeAsync before capture so the mic is live and
 *      the remote track plays. iOS does NOT route a WebRTC playAndRecord session
 *      to the loudspeaker by default (it prefers the earpiece) and there is no JS
 *      API for it, so the native build's config plugin adds defaultToSpeaker to
 *      react-native-webrtc's audio session category options (AirPods still win
 *      when connected). Transcripts arrive as data-channel events.
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
import NetInfo from "@react-native-community/netinfo";
import { setAudioModeAsync } from "expo-audio";
import {
  createRealtimeSession,
  endRealtimeSession,
  heartbeatRealtimeSession,
  ApiRequestError,
} from "@/lib/api";
import type {
  RealtimeHeartbeatResult,
  RealtimeOverLimit,
  RealtimeSessionContext,
} from "@/lib/types";

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

/**
 * Coarse connection-health signal derived from the diagnostics ring buffer.
 * "good" = stable; "degraded" = transient trouble (repeated audio stops or an
 * ICE `disconnected`); "reconnecting" = the single automatic recovery attempt is
 * in flight; "legacy" = realtime was abandoned for the basic voice loop.
 */
export type NetworkQuality = "good" | "degraded" | "reconnecting" | "legacy";

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
   * Set when the per-plan live-voice budget is exhausted (at start or mid-call).
   * The caller shows a graceful "out of voice time" state with the reset time
   * instead of falling back to the legacy loop (which would bypass the cap).
   */
  overLimit: RealtimeOverLimit | null;
  /**
   * Attempt to start a realtime session. Resolves with `started: true` once the
   * SDP exchange completes, or `started: false` plus a human-readable `reason`
   * the caller can surface as a visible warning before dropping to the legacy
   * voice loop. The reason is returned (not just stored in state) so the caller
   * can read it synchronously after the await.
   */
  start: (
    ctx: RealtimeStartContext,
    opts?: { isReconnect?: boolean },
  ) => Promise<{ started: boolean; reason: string | null; overLimit?: boolean }>;
  stop: () => void;
  interrupt: () => void;
  toggleMute: () => void;
  /**
   * Coarse connection-health signal for the UI quality dot. Derived from the
   * diagnostics ring buffer; never sent to any server.
   */
  networkQuality: NetworkQuality;
  /**
   * True after >= 2 `output_audio_buffer.stopped` events within 30 s without a
   * matching `started` — used to surface the "Connection issues?" chip. Clears
   * when quality recovers.
   */
  connectionIssue: boolean;
  /**
   * Manually restart a fresh realtime session after a fallback (the Retry
   * button). Resets the single-attempt reconnect guard and re-mints from
   * scratch using the last start context.
   */
  retry: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DATA_CHANNEL_NAME = "oai-events";
const SDP_TIMEOUT_MS = 15_000;
// How often to beat the live-voice budget when the server does not specify a
// cadence. Each beat charges elapsed seconds and re-syncs the remaining time.
// Mirrors the website hook.
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
// Below this many seconds left, the countdown UI shows a "running low" warning.
// Kept in sync with the website hook's LOW_TIME_WARNING_SECONDS.
export const LOW_TIME_WARNING_SECONDS = 60;

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
// A transient `output_audio_buffer.stopped` can fire mid-reply (the realtime API
// chunks playback) and is immediately followed by another `started`. Debounce the
// stop -> "listening" UI flip by this long so Ora's status does not flicker
// between speaking and listening during one continuous reply. `response.done` and
// a client-initiated clear still flip immediately.
const OUTPUT_STOP_DEBOUNCE_MS = 600;
// If the state remains "thinking" for this long without Ora starting to speak
// or response.done arriving, assume the event was lost and recover to
// "listening". 15 s sits comfortably above real model latency while preventing
// an indefinite stuck state caused by a dropped data-channel message.
const THINKING_WATCHDOG_MS = 15_000;

// ─── Poor-network resilience tuning (mirrored in the website hook) ───────────
// On the first connection drop the app waits this long before the single
// automatic reconnect attempt, giving a flaky link a moment to settle. A NetInfo
// reachability-restored event cancels the wait and fires the reconnect at once.
const RECONNECT_DELAY_MS = 2_000;
// Sliding window + threshold for the "Connection issues?" instability chip: this
// many `output_audio_buffer.stopped` events (without a matching `started`) inside
// the window flags a degraded connection.
const AUDIO_STOP_WINDOW_MS = 30_000;
const AUDIO_STOP_THRESHOLD = 2;
// The diagnostics ring buffer keeps only the most recent events; it is used only
// to derive UI state and optional debug logs and is NEVER sent to any server.
const DIAG_RING_SIZE = 20;

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

// ORA_REALTIME_TOKENIZER_PARITY_START
function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}
function tokenizeTranscript(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter(Boolean);
}
// ORA_REALTIME_TOKENIZER_PARITY_END
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

// ORA_REALTIME_FOCUS_SCORER_PARITY_START
export type FocusMode = "normal" | "focused";
// Opening Talk to Ora is treated as an explicit address, so the first utterance
// gets a longer multilingual grace window. After that, follow-ups get a short
// window only; outside it, speech must be addressed/directed so a nearby side
// conversation no longer makes Ora speak or interrupt.
const FOCUS_COLD_START_WINDOW_MS = 12_000;
const FOCUS_FOLLOWUP_WINDOW_MS = 4_000;

// Wake / address tokens that re-open focus after silence or background chatter.
// Latin "ora" plus common ASR variants and non-Latin transliterations, so the
// wake word is recognized regardless of the speaker's language or script. Latin
// and Arabic entries are stored diacritic-folded (see matchesLeadSet); scripts
// whose vowel signs are combining marks (Devanagari) are stored and matched raw.
const ORA_ADDRESS_TOKENS = new Set([
  "ora",
  "oraa",
  "orah",
  "orra",
  "aura",
  "اورا",
  "اوراه",
  "ора",
  "ओरा",
  "ओराह",
]);
// Greeting words that, immediately followed by an address token, still address
// Ora ("hey ora", "hola ora", "salut ora"). Multilingual, diacritic-folded.
const ADDRESS_LEAD_WORDS = new Set([
  "hey",
  "hi",
  "hello",
  "ok",
  "okay",
  "yo",
  "hola",
  "salut",
  "ola",
  "hallo",
  "ciao",
  "selam",
  "merhaba",
  "مرحبا",
  "اهلا",
  "नमस्ते",
  "नमस्कार",
]);
// Interrogative / imperative lead words: a transcript whose FIRST or LAST token
// is one reads as a directed request to Ora even without a wake word, so a
// cold-start or re-engagement turn is accepted. Deliberately NOT English-only —
// it covers the languages Ora supports (verb-first AND verb-final word orders),
// so a non-English directed turn outside the focus window is not wrongly
// rejected. Inside the window any language is already accepted; this only gates
// idle / post-background speech. Latin + Arabic entries are stored
// diacritic-folded; Devanagari entries are stored and matched raw.
const DIRECT_LEAD_WORDS = new Set([
  "what",
  "whats",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "whose",
  "can",
  "could",
  "would",
  "will",
  "should",
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "please",
  "tell",
  "explain",
  "show",
  "give",
  "help",
  "make",
  "write",
  "find",
  "search",
  "translate",
  "summarize",
  "summarise",
  "create",
  "read",
  "open",
  "list",
  "define",
  "describe",
  "compare",
  "calculate",
  "convert",
  // Spanish
  "que",
  "como",
  "cual",
  "cuales",
  "cuando",
  "donde",
  "quien",
  "cuanto",
  "puedes",
  "puede",
  "dime",
  "explica",
  "explicame",
  "traduce",
  "ayuda",
  "ayudame",
  "muestra",
  "escribe",
  "busca",
  "resume",
  "crea",
  "describe",
  // French
  "quoi",
  "comment",
  "quel",
  "quelle",
  "quand",
  "qui",
  "combien",
  "pourquoi",
  "peux",
  "peuxtu",
  "dis",
  "dismoi",
  "explique",
  "traduis",
  "aide",
  "aidemoi",
  "montre",
  "ecris",
  "cherche",
  "definis",
  // Portuguese
  "oque",
  "quais",
  "onde",
  "quem",
  "quanto",
  "porque",
  "pode",
  "diga",
  "explique",
  "traduz",
  "ajuda",
  "ajude",
  "mostra",
  "escreve",
  "leia",
  // German
  "was",
  "wie",
  "welche",
  "welcher",
  "wann",
  "wo",
  "wer",
  "warum",
  "wieso",
  "kannst",
  "kann",
  "sag",
  "sage",
  "erklare",
  "erklaere",
  "ubersetze",
  "uebersetze",
  "hilf",
  "zeig",
  "zeige",
  "schreib",
  "suche",
  "erstelle",
  // Italian
  "cosa",
  "che",
  "come",
  "quale",
  "dove",
  "chi",
  "perche",
  "puoi",
  "potresti",
  "dimmi",
  "spiega",
  "spiegami",
  "traduci",
  "aiuto",
  "aiutami",
  "scrivi",
  "cerca",
  "riassumi",
  "apri",
  "leggi",
  // Turkish (dotted-i and dotless-i variants both listed)
  "ne",
  "nasil",
  "nasıl",
  "hangi",
  "nerede",
  "kim",
  "neden",
  "nicin",
  "niçin",
  "misin",
  "mısın",
  "soyle",
  "söyle",
  "anlat",
  "acikla",
  "açıkla",
  "cevir",
  "çevir",
  "yardim",
  "yardım",
  "goster",
  "göster",
  "ozetle",
  "özetle",
  // Arabic (stored without harakat; folded at match time)
  "ما",
  "ماذا",
  "كيف",
  "لماذا",
  "متى",
  "اين",
  "من",
  "كم",
  "هل",
  "اشرح",
  "وضح",
  "ترجم",
  "ساعدني",
  "ساعد",
  "اظهر",
  "اعرض",
  "اكتب",
  "ابحث",
  "لخص",
  "اخبرني",
  // Hindi / Urdu
  "क्या",
  "कैसे",
  "क्यों",
  "कब",
  "कौन",
  "कितना",
  "बताओ",
  "समझाओ",
  "अनुवाद",
  "दिखाओ",
  "मदद",
  "کیا",
  "کیسے",
  "کیوں",
  "کہاں",
  "بتاؤ",
  "سمجھاؤ",
  "مدد",
  "دکھاؤ",
]);

// Question marks across writing systems: Latin "?", Arabic/Urdu "؟" (U+061F),
// full-width CJK "？" (U+FF1F), Armenian "՞" (U+055E). A trailing question mark
// signals a directed question in any of Ora's supported languages, not only
// English, so non-Latin questions outside the focus window are still accepted.
const QUESTION_MARKS = ["?", "\u061F", "\uFF1F", "\u055E"];
function endsWithQuestionMark(text: string): boolean {
  const trimmed = text.trim();
  return QUESTION_MARKS.some((mark) => trimmed.endsWith(mark));
}
// Case/diacritic folding (NFD + strip combining marks) so accented Latin and
// harakat-bearing Arabic spellings match a single stored entry. Tokens are
// already lowercased by tokenizeTranscript. Pure and locale-independent so the
// result is identical on web and mobile.
function foldForMatch(word: string): string {
  return word.normalize("NFD").replace(/\p{M}+/gu, "");
}
// Match a token against a lead/address set by BOTH its raw and folded form. The
// raw check preserves scripts whose vowel signs are combining marks and must NOT
// be stripped (Devanagari); the folded check unifies accented Latin / Arabic.
function matchesLeadSet(word: string, set: Set<string>): boolean {
  return set.has(word) || set.has(foldForMatch(word));
}

/** True when the utterance names Ora at the start (a wake / address phrase). */
export function isAddressedToOra(words: string[]): boolean {
  if (words.length === 0) return false;
  if (matchesLeadSet(words[0], ORA_ADDRESS_TOKENS)) return true;
  if (
    words.length >= 2 &&
    matchesLeadSet(words[0], ADDRESS_LEAD_WORDS) &&
    matchesLeadSet(words[1], ORA_ADDRESS_TOKENS)
  ) {
    return true;
  }
  return false;
}

/** True when the utterance reads as a directed command or question to Ora. */
export function looksDirected(words: string[], text: string): boolean {
  if (words.length === 0) return false;
  // A trailing question mark (any script) is the strongest cross-language signal.
  if (endsWithQuestionMark(text)) return true;
  // Verb-first (English / Romance / Arabic) and verb-final (Turkish / Hindi /
  // Urdu) languages place the directive at the START or END of the utterance, so
  // a lead word in either position reads as directed.
  if (matchesLeadSet(words[0], DIRECT_LEAD_WORDS)) return true;
  if (matchesLeadSet(words[words.length - 1], DIRECT_LEAD_WORDS)) return true;
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

function focusWindowMsForTurnCount(acceptedTurnCount: number): number {
  return acceptedTurnCount <= 0 ? FOCUS_COLD_START_WINDOW_MS : FOCUS_FOLLOWUP_WINDOW_MS;
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
    acceptedTurnCount: number;
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
  // Opening Talk to Ora is an explicit address, so the FIRST utterance gets a
  // longer multilingual cold-start window. After that, keep ambient-room exposure
  // short: natural follow-ups still work, but nearby conversations no longer get
  // a fresh 12s open mic after every accepted turn.
  if (opts.msSinceLastAcceptedTurn <= focusWindowMsForTurnCount(opts.acceptedTurnCount)) {
    return { accepted: true, viaWindow: true };
  }
  // Idle / post-background: require an explicit address or a directed request.
  if (isAddressedToOra(words) || looksDirected(words, text)) return { accepted: true };
  return { accepted: false, reason: "not_addressed_or_outside_focus" };
}
// ORA_REALTIME_FOCUS_SCORER_PARITY_END

/**
 * Structured, privacy-safe realtime voice diagnostics. Emits event names, counts,
 * reasons, and the selected language — NEVER raw audio or full transcript text —
 * so barge-in / transcript-filter decisions can be inspected in the device log.
 */
function logVoiceDiag(event: string, detail?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.info("[ora-realtime]", JSON.stringify({ event, ...detail }));
}

/**
 * Per-turn latency marks (epoch ms) used to log privacy-safe timing deltas for
 * each phase of a realtime turn: speech end -> transcript -> response.create ->
 * model response -> audio playback -> done. Holds NO audio or transcript text.
 */
interface TurnTiming {
  speechStartedAt: number;
  speechStoppedAt: number;
  transcriptCompletedAt: number;
  responseCreateSentAt: number;
  responseCreatedAt: number;
  outputStartedAt: number;
  outputStoppedAt: number;
  outputCycles: number;
}

function newTurnTiming(): TurnTiming {
  return {
    speechStartedAt: 0,
    speechStoppedAt: 0,
    transcriptCompletedAt: 0,
    responseCreateSentAt: 0,
    responseCreatedAt: 0,
    outputStartedAt: 0,
    outputStoppedAt: 0,
    outputCycles: 0,
  };
}

/** Positive delta between two epoch-ms marks, or null when either is unset. */
function deltaMs(from: number, to: number): number | null {
  return from > 0 && to >= from ? to - from : null;
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

/**
 * TEST-SEAM ONLY — never call in production code.
 * Bypasses the guarded require() so unit tests can inject a fake WebRTC module
 * without depending on Metro's CJS require or a native build.
 */
export function _setWebRTCModuleForTest(mod: WebRTCModuleType | null): void {
  cachedModule = mod;
  loadAttempted = true;
}

/** TEST-SEAM ONLY — resets loadWebRTC() cache between tests. */
export function _resetWebRTCCacheForTest(): void {
  cachedModule = null;
  loadAttempted = false;
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
  connectionState?: string;
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
  const [overLimit, setOverLimit] = useState<RealtimeOverLimit | null>(null);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>("good");
  const [connectionIssue, setConnectionIssue] = useState(false);

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
  // Live-voice budget metering. heartbeatTimerRef beats the per-plan budget;
  // realtimeSessionIdRef + sessionStartedAtRef drive the elapsed-seconds charge
  // and the local countdown. The server clock stays authoritative.
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const realtimeSessionIdRef = useRef<string | null>(null);
  const sessionStartedAtRef = useRef(0);
  const sdpAbortRef = useRef<AbortController | null>(null);
  const userTextRef = useRef("");
  const assistantTextRef = useRef("");
  const activeRef = useRef(false);
  // Monotonically increasing session generation. Incremented by fullTeardown() (and
  // captured by each start()) so an in-flight start() can tell whether a rapid
  // stop -> restart has superseded it. activeRef alone is ambiguous: a new start
  // sets it true again, which would let a stale async start() falsely treat
  // itself as current and clobber the shared stream/pc/dc refs.
  const startGenerationRef = useRef(0);
  const mutedRef = useRef(false);

  // ── Poor-network resilience (diagnostics + single-retry reconnect) ──────────
  // diagRef: bounded ring buffer of the most recent lifecycle events. Used only
  // to derive UI state / debug logs; NEVER sent to any server.
  const diagRef = useRef<{ at: number; event: string; detail?: Record<string, unknown> }[]>([]);
  // reconnectAttemptedRef: guards the "only ONE automatic reconnect" rule — once
  // true, the next drop goes straight to legacy fallback. Reset on a fresh
  // (non-reconnect) start() and on a manual retry().
  const reconnectAttemptedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // reconnectConsumedRef: one-shot latch so the backoff timer and a NetInfo
  // reachability-restored event can never both fire the same reconnect.
  const reconnectConsumedRef = useRef(false);
  // pendingReconnectFireRef: set while waiting out RECONNECT_DELAY_MS so a
  // NetInfo reachability-restored event can trigger the reconnect immediately.
  const pendingReconnectFireRef = useRef<(() => void) | null>(null);
  // lastCtxRef: the most recent start context, replayed when reconnecting/retrying.
  const lastCtxRef = useRef<RealtimeStartContext | null>(null);
  // audioStopTimestampsRef: timestamps of recent unmatched output_audio stops,
  // pruned to AUDIO_STOP_WINDOW_MS, feeding the instability chip.
  const audioStopTimestampsRef = useRef<number[]>([]);
  // networkQualityRef: mirrors the networkQuality state for synchronous reads in
  // event handlers (which run outside React's render).
  const networkQualityRef = useRef<NetworkQuality>("good");

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
  const acceptedUserTurnCountRef = useRef(0);
  // Per-turn latency marks + the debounce timer that smooths the playback-stop UI
  // flip (see OUTPUT_STOP_DEBOUNCE_MS).
  const turnTimingRef = useRef<TurnTiming>(newTurnTiming());
  const outputStopDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Watchdog: clears a stuck "thinking" state if response.done never arrives.
  const thinkingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const clearHeartbeatTimer = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  // Best-effort end beacon: tell the server the live-voice session ended so it
  // finalizes the charge now instead of waiting for stale-session expiry. The
  // server clock is authoritative and stale expiry is the safety net if this
  // never lands, so this never blocks fullTeardown and never throws. Reports only the
  // session id + client-measured elapsed seconds — never audio/transcript.
  const finalizeSession = useCallback(() => {
    const id = realtimeSessionIdRef.current;
    if (!id) return;
    realtimeSessionIdRef.current = null;
    const startedAt = sessionStartedAtRef.current;
    sessionStartedAtRef.current = 0;
    const durationSeconds =
      startedAt > 0 ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : undefined;
    logVoiceDiag("session_end_sent", { duration_seconds: durationSeconds ?? null });
    try {
      void endRealtimeSession(id, durationSeconds).catch(() => {
        /* best-effort — stale-session expiry finalizes if this never lands */
      });
    } catch {
      /* never let fullTeardown throw */
    }
  }, []);

  const clearBargeInTimer = useCallback(() => {
    if (bargeInTimerRef.current) {
      clearTimeout(bargeInTimerRef.current);
      bargeInTimerRef.current = null;
    }
    pendingBargeInRef.current = false;
  }, []);

  // ── Diagnostics ring buffer + derived connection-quality helpers ────────────
  // recordDiag appends to a bounded in-memory ring (last DIAG_RING_SIZE events).
  // It is used ONLY to derive UI state and optional debug logs — never sent to a
  // server. Kept privacy-safe: callers pass counts/reasons, never audio/transcript.
  const recordDiag = useCallback((event: string, detail?: Record<string, unknown>) => {
    const buf = diagRef.current;
    buf.push({ at: Date.now(), event, detail });
    if (buf.length > DIAG_RING_SIZE) buf.splice(0, buf.length - DIAG_RING_SIZE);
  }, []);

  const applyNetworkQuality = useCallback((q: NetworkQuality) => {
    networkQualityRef.current = q;
    setNetworkQuality(q);
  }, []);

  // Repeated audio stops without a matching restart inside the sliding window mean
  // the media path is faltering: raise the instability chip + degrade the dot.
  const noteAudioStop = useCallback(() => {
    const now = Date.now();
    const recent = audioStopTimestampsRef.current.filter((t) => now - t < AUDIO_STOP_WINDOW_MS);
    recent.push(now);
    audioStopTimestampsRef.current = recent;
    if (recent.length >= AUDIO_STOP_THRESHOLD) {
      setConnectionIssue(true);
      if (networkQualityRef.current === "good") applyNetworkQuality("degraded");
    }
  }, [applyNetworkQuality]);

  // Audio is flowing again (a clean start or response.done): clear the instability
  // signal. Never overrides an in-flight reconnect/legacy state.
  const noteAudioProgress = useCallback(() => {
    audioStopTimestampsRef.current = [];
    setConnectionIssue(false);
    if (networkQualityRef.current === "degraded") applyNetworkQuality("good");
  }, [applyNetworkQuality]);

  const fullTeardown = useCallback(() => {
    activeRef.current = false;
    // Invalidate any in-flight start(): its captured generation no longer matches.
    startGenerationRef.current += 1;
    clearDurationTimer();
    clearHeartbeatTimer();
    clearBargeInTimer();
    // Cancel any pending backoff reconnect so a stale timer can never resurrect a
    // superseded session. Instability tracking resets with the connection.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    pendingReconnectFireRef.current = null;
    audioStopTimestampsRef.current = [];
    finalizeSession();
    if (outputStopDebounceRef.current) {
      clearTimeout(outputStopDebounceRef.current);
      outputStopDebounceRef.current = null;
    }
    if (thinkingWatchdogRef.current) {
      clearTimeout(thinkingWatchdogRef.current);
      thinkingWatchdogRef.current = null;
    }
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
  }, [clearDurationTimer, clearHeartbeatTimer, clearBargeInTimer, finalizeSession]);

  // start() is defined below but the reconnect helpers need to call it, so it is
  // reached through a ref to break the declaration cycle.
  const startRef = useRef<UseOraRealtimeVoiceNativeReturn["start"] | null>(null);

  // Give up on realtime and hand control to the legacy transcribe -> chat -> tts
  // loop. The dot goes grey ("legacy"); the caller shows the Retry button.
  const enterLegacyFallback = useCallback(
    (reason: string) => {
      recordDiag("legacy_fallback", { reason });
      fullTeardown();
      setState("idle");
      setFallbackReason(reason);
      setConnectionIssue(false);
      applyNetworkQuality("legacy");
      onFallbackRef.current?.(reason);
    },
    [fullTeardown, recordDiag, applyNetworkQuality],
  );

  // The single automatic recovery attempt: fully tear down the dropped session,
  // wait out the backoff (cancellable by NetInfo), then re-mint + rebuild from
  // scratch. Only ONE attempt — a second drop routes straight to legacy.
  const scheduleReconnect = useCallback(
    (reason: string) => {
      const ctx = lastCtxRef.current;
      if (!ctx) {
        enterLegacyFallback(reason);
        return;
      }
      reconnectAttemptedRef.current = true;
      reconnectConsumedRef.current = false;
      recordDiag("reconnect_scheduled", { reason, delay_ms: RECONNECT_DELAY_MS });
      // fullTeardown clears the old pc/dc/mic + fires the /end beacon for the old
      // token, so the reconnect mints a genuinely fresh session.
      fullTeardown();
      applyNetworkQuality("reconnecting");
      setState("connecting");

      const fire = () => {
        if (reconnectConsumedRef.current) return;
        reconnectConsumedRef.current = true;
        pendingReconnectFireRef.current = null;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        recordDiag("reconnect_firing");
        void startRef.current?.(ctx, { isReconnect: true }).then((result) => {
          if (result?.started) {
            recordDiag("reconnect_succeeded");
            applyNetworkQuality("good");
          } else if (!result?.overLimit) {
            // A genuine reconnect failure (not an out-of-minutes stop) drops to
            // legacy. overLimit already surfaced its own graceful state.
            enterLegacyFallback(reason);
          }
        });
      };

      pendingReconnectFireRef.current = fire;
      reconnectTimerRef.current = setTimeout(fire, RECONNECT_DELAY_MS);
    },
    [enterLegacyFallback, fullTeardown, recordDiag, applyNetworkQuality],
  );

  // A mid-call connection drop (ICE failed/disconnected, data-channel close/error,
  // or an unrecoverable connection-state change). First drop -> one auto-reconnect;
  // any subsequent drop -> legacy fallback.
  const handleConnectionDrop = useCallback(
    (reason: string) => {
      if (!activeRef.current) return;
      recordDiag("connection_drop", { reason, reconnect_attempted: reconnectAttemptedRef.current });
      if (reconnectAttemptedRef.current) {
        enterLegacyFallback(reason);
      } else {
        scheduleReconnect(reason);
      }
    },
    [enterLegacyFallback, scheduleReconnect, recordDiag],
  );

  const stop = useCallback(() => {
    if (!activeRef.current && state === "idle") return;
    fullTeardown();
    setInterimUserTranscript("");
    setInterimAssistantTranscript("");
    setRemainingSeconds(null);
    userTextRef.current = "";
    assistantTextRef.current = "";
    setState((s) => (s === "error" || s === "unsupported" ? s : "ended"));
  }, [fullTeardown, state]);

  // Beat the per-plan live-voice budget on a cadence: charge the elapsed seconds
  // for this session and re-sync the displayed countdown to the server budget
  // (authoritative). A 503 means metering is unavailable (fail-closed -> drop to
  // the legacy loop, which is metered by Ora chat quotas); a 404 / `ended:true` /
  // remaining<=0 means the budget is spent (end gracefully, NO fallback, since
  // that would bypass the cap). A network blip is ignored — the next beat or the
  // server's stale-session expiry reconciles the charge. Reports only the session
  // id + client-measured elapsed seconds, never audio or transcript text.
  const sendHeartbeat = useCallback(async () => {
    const id = realtimeSessionIdRef.current;
    if (!id) return;
    const durationSeconds =
      sessionStartedAtRef.current > 0
        ? Math.max(0, Math.floor((Date.now() - sessionStartedAtRef.current) / 1000))
        : 0;

    let body: RealtimeHeartbeatResult | null = null;
    let httpStatus = 0;
    let httpOk = false;
    try {
      body = await heartbeatRealtimeSession(id, durationSeconds);
      httpStatus = 200;
      httpOk = true;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        httpStatus = err.status;
        if (err.body && typeof err.body === "object") {
          body = err.body as RealtimeHeartbeatResult;
        }
      } else {
        // Network blip — do NOT end the call. The next beat (or stale-session
        // expiry on the server) reconciles the charge.
        logVoiceDiag("heartbeat_network_error");
        return;
      }
    }

    // Re-sync the displayed countdown to the server budget (authoritative), but
    // never raise it above the local per-session countdown.
    if (httpOk && typeof body?.remainingSeconds === "number") {
      const serverRemaining = Math.max(0, Math.floor(body.remainingSeconds));
      setRemainingSeconds((prev) =>
        prev == null ? serverRemaining : Math.min(prev, serverRemaining),
      );
    }

    const failClosed = httpStatus === 503;
    const budgetEnded =
      body?.ended === true || httpStatus === 404 || (body?.remainingSeconds ?? 1) <= 0;
    if (!failClosed && !budgetEnded) return;
    if (!activeRef.current) return;

    // The server has finalized (or can't be reached): skip the redundant /end.
    realtimeSessionIdRef.current = null;
    logVoiceDiag("heartbeat_ended", { status: httpStatus, fail_closed: failClosed });

    if (failClosed) {
      // Metering outage — fall back to the legacy loop (text + TTS is metered by
      // Ora chat quotas, not the realtime budget) instead of stranding the user.
      const reason = "Live voice is temporarily unavailable. Using basic voice mode.";
      fullTeardown();
      setInterimUserTranscript("");
      setInterimAssistantTranscript("");
      setRemainingSeconds(null);
      setState("idle");
      setFallbackReason(reason);
      onFallbackRef.current?.(reason);
      return;
    }

    // Budget exhausted — end gracefully with the reset time. Do NOT fall back
    // (that would bypass the per-plan voice cap).
    fullTeardown();
    setInterimUserTranscript("");
    setInterimAssistantTranscript("");
    setRemainingSeconds(0);
    setOverLimit({
      message:
        "You've used all your live voice time for now. It refreshes later — you can keep chatting with Ora by text in the meantime.",
      resetsAt: body?.resetsAt ?? null,
      upgradeAvailable: false,
    });
    setState("ended");
  }, [fullTeardown]);

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

  // In focused mode, automatic barge-in is intentionally stricter than turn
  // acceptance. If Ora is already speaking, only addressed/directed speech may
  // stop her; otherwise nearby conversation inside the follow-up window can still
  // chop Ora mid-sentence. The manual Interrupt button remains immediate.
  const bargeInRequiresDirection = useCallback(() => focusModeRef.current === "focused", []);

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
      // A confirmed barge-in is an intentional hard stop — drop any pending stop
      // debounce so the UI flips to "listening" immediately.
      if (outputStopDebounceRef.current) {
        clearTimeout(outputStopDebounceRef.current);
        outputStopDebounceRef.current = null;
      }
      stopAssistantOutput();
      logVoiceDiag("assistant_cancelled_for_barge_in", {
        reason,
        output_cycles: turnTimingRef.current.outputCycles,
      });
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
          turnTimingRef.current = newTurnTiming();
          turnTimingRef.current.speechStartedAt = Date.now();
          logVoiceDiag("speech_started", {
            assistantActive: assistantResponseActiveRef.current,
            assistantSpeaking: assistantSpeakingRef.current,
            focus_mode: focusModeRef.current,
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
                  !bargeInRequiresDirection() || isAddressedOrDirected(userTextRef.current);
                if (directedEnough) {
                  confirmBargeIn("sustained_speech");
                } else {
                  // Likely a background speaker while the user is not engaged. Keep
                  // the barge-in pending (a later addressed delta can still confirm
                  // it) but do NOT cut Ora off on sustained speech alone.
                  logVoiceDiag("barge_in_deferred", { reason: "requires_directed_speech" });
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
          turnTimingRef.current.speechStoppedAt = Date.now();
          logVoiceDiag("speech_stopped", {
            pendingBargeIn: pendingBargeInRef.current,
            since_speech_started_ms: deltaMs(
              turnTimingRef.current.speechStartedAt,
              turnTimingRef.current.speechStoppedAt,
            ),
          });
          if (pendingBargeInRef.current) {
            // Speech ended before it could be confirmed: treat as a noise blip and
            // leave Ora speaking.
            cancelPendingBargeIn("speech_stopped_before_confirm");
          } else if (activeRef.current) {
            setState("thinking");
            // Start the watchdog. If response.done never arrives (lost data-channel
            // message or model error) we recover to "listening" automatically.
            if (thinkingWatchdogRef.current) clearTimeout(thinkingWatchdogRef.current);
            thinkingWatchdogRef.current = setTimeout(() => {
              thinkingWatchdogRef.current = null;
              if (activeRef.current) {
                logVoiceDiag("thinking_watchdog_timeout");
                assistantResponseActiveRef.current = false;
                setState("listening");
              }
            }, THINKING_WATCHDOG_MS);
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
                !bargeInRequiresDirection() || isAddressedOrDirected(userTextRef.current);
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
          // still arrive on the data channel AFTER stop()/fullTeardown() (e.g. the user
          // switched conversation), and persisting it then would append to the new
          // thread's messages — the wrong-thread bug. fullTeardown() sets activeRef
          // false, so a post-fullTeardown event is dropped here.
          if (!activeRef.current) break;
          const trimmed = (finalText || "").trim();
          const focusMode = focusModeRef.current;
          const msSinceLastAcceptedTurn = Date.now() - lastAcceptedUserTurnAtRef.current;
          const acceptedTurnCount = acceptedUserTurnCountRef.current;
          const activeFocusWindowMs = focusWindowMsForTurnCount(acceptedTurnCount);
          turnTimingRef.current.transcriptCompletedAt = Date.now();
          logVoiceDiag("transcript_completed", {
            chars: trimmed.length,
            focus_mode: focusMode,
            accepted_turn_count: acceptedTurnCount,
            speech_stopped_to_transcript_completed_ms: deltaMs(
              turnTimingRef.current.speechStoppedAt,
              turnTimingRef.current.transcriptCompletedAt,
            ),
          });
          const verdict = scoreTranscriptFocus(trimmed, {
            focusMode,
            sinceAssistantAudioMs: Date.now() - lastAssistantAudioAtRef.current,
            recentAssistantText: recentAssistantSpeechRef.current,
            msSinceLastAcceptedTurn,
            acceptedTurnCount,
          });
          if (verdict.accepted) {
            // Accepted turns keep the user engaged, but after the first utterance
            // the follow-up window is intentionally short so nearby conversations
            // are less likely to be treated as the main user.
            lastAcceptedUserTurnAtRef.current = Date.now();
            acceptedUserTurnCountRef.current = acceptedTurnCount + 1;
            logVoiceDiag("transcript_accepted", {
              chars: trimmed.length,
              focus_mode: focusMode,
              accepted_turn_count: acceptedTurnCount,
              focus_window_active: msSinceLastAcceptedTurn <= activeFocusWindowMs,
              focus_window_ms: activeFocusWindowMs,
              via_focus_window: verdict.viaWindow === true,
              selected_language: selectedLanguageRef.current,
            });
            onUserRef.current(trimmed);
            // Focused mode: the server does NOT auto-respond (create_response is
            // false), so the client explicitly requests Ora's reply — ONLY here, for
            // an accepted, addressed/engaged turn. Rejected background speech never
            // reaches this line, so Ora stays silent for other speakers.
            if (focusMode === "focused") {
              turnTimingRef.current.responseCreateSentAt = Date.now();
              sendEvent({ type: "response.create" });
              logVoiceDiag("response_create_sent", {
                transcript_completed_to_response_create_sent_ms: deltaMs(
                  turnTimingRef.current.transcriptCompletedAt,
                  turnTimingRef.current.responseCreateSentAt,
                ),
              });
            }
          } else {
            logVoiceDiag("transcript_rejected", {
              rejection_reason: verdict.reason,
              chars: trimmed.length,
              focus_mode: focusMode,
              accepted_turn_count: acceptedTurnCount,
              focus_window_active: msSinceLastAcceptedTurn <= activeFocusWindowMs,
              focus_window_ms: activeFocusWindowMs,
              selected_language: selectedLanguageRef.current,
            });
            // Focused mode keeps create_response off, so the server never replies
            // to this rejected turn — but it still recorded the transcribed input
            // as a conversation item. Delete it so rejected background speech can
            // never condition a later accepted response (e.g. pulling Ora into a
            // bystander's language). Normal mode leaves server-owned items alone
            // because the server auto-responds there.
            if (focusMode === "focused" && typeof evt.item_id === "string" && evt.item_id) {
              sendEvent({ type: "conversation.item.delete", item_id: evt.item_id });
            }
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

        case "response.created": {
          const createdAt = Date.now();
          const t = turnTimingRef.current;
          t.responseCreatedAt = createdAt;
          t.outputCycles = 0;
          t.outputStartedAt = 0;
          t.outputStoppedAt = 0;
          assistantResponseActiveRef.current = true;
          assistantTextRef.current = "";
          setInterimAssistantTranscript("");
          recordDiag("response.created", { focus_mode: focusModeRef.current });
          logVoiceDiag("response_created", {
            focus_mode: focusModeRef.current,
            response_create_sent_to_response_created_ms: deltaMs(t.responseCreateSentAt, createdAt),
            transcript_completed_to_response_created_ms: deltaMs(
              t.transcriptCompletedAt,
              createdAt,
            ),
            speech_stopped_to_response_created_ms: deltaMs(t.speechStoppedAt, createdAt),
          });
          if (activeRef.current) {
            setState("thinking");
            // Re-arm the watchdog: response.created can arrive after speech_stopped
            // (overlapping turns), so reset the deadline to give the model a fresh
            // 15 s from this point.
            if (thinkingWatchdogRef.current) clearTimeout(thinkingWatchdogRef.current);
            thinkingWatchdogRef.current = setTimeout(() => {
              thinkingWatchdogRef.current = null;
              if (activeRef.current) {
                logVoiceDiag("thinking_watchdog_timeout");
                assistantResponseActiveRef.current = false;
                setState("listening");
              }
            }, THINKING_WATCHDOG_MS);
          }
          break;
        }

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
          // fullTeardown can't append Ora's reply to a newly-switched conversation.
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

        case "output_audio_buffer.started": {
          const now = Date.now();
          const t = turnTimingRef.current;
          t.outputCycles += 1;
          // Audio is (re)starting, so any pending stop -> "listening" flip from a
          // transient `stopped` was premature — cancel it.
          if (outputStopDebounceRef.current) {
            clearTimeout(outputStopDebounceRef.current);
            outputStopDebounceRef.current = null;
          }
          // Audio arrived: the model is clearly making progress, so the thinking
          // watchdog is no longer needed.
          if (thinkingWatchdogRef.current) {
            clearTimeout(thinkingWatchdogRef.current);
            thinkingWatchdogRef.current = null;
          }
          assistantSpeakingRef.current = true;
          lastAssistantAudioAtRef.current = now;
          if (remoteTrackRef.current) remoteTrackRef.current.enabled = !mutedRef.current;
          if (t.outputCycles === 1) {
            t.outputStartedAt = now;
            logVoiceDiag("output_audio_started", {
              response_created_to_output_started_ms: deltaMs(t.responseCreatedAt, now),
            });
          } else {
            logVoiceDiag("output_audio_restarted", { output_cycles: t.outputCycles });
          }
          recordDiag("output_audio_buffer.started", { output_cycles: t.outputCycles });
          // Audio is flowing: the media path is healthy again, so clear any
          // lingering instability signal.
          noteAudioProgress();
          if (activeRef.current) setState("speaking");
          break;
        }
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared": {
          const now = Date.now();
          const t = turnTimingRef.current;
          t.outputStoppedAt = now;
          assistantSpeakingRef.current = false;
          lastAssistantAudioAtRef.current = now;
          // clientInitiated distinguishes our own confirmed barge-in cancel from a
          // server-driven cancel (e.g. server VAD interrupt_response). A
          // clientInitiated:false clear while Ora was mid-turn means the BACKEND —
          // not noise on the client — cut Ora off.
          const clientInitiated = now - clientCancelledAtRef.current < 1000;
          logVoiceDiag("output_audio_stopped", {
            type,
            clientInitiated,
            output_cycles: t.outputCycles,
            output_started_to_output_stopped_ms: deltaMs(t.outputStartedAt, now),
          });
          recordDiag("output_audio_buffer.stopped", { type, clientInitiated });
          // A genuine (non-client-initiated) stop of a real `stopped` event feeds
          // the instability window. Our own barge-in clears are intentional and
          // never count as trouble.
          if (type === "output_audio_buffer.stopped" && !clientInitiated) {
            noteAudioStop();
          }
          // A client-initiated clear (our own confirmed barge-in) is an intentional
          // hard stop — flip to "listening" now. Otherwise the realtime API can emit
          // a transient `stopped` mid-reply that is immediately followed by another
          // `started`; debounce the flip so the status does not flicker. If audio
          // restarts the debounce is cancelled; `response.done` flips immediately.
          if (clientInitiated && type === "output_audio_buffer.cleared") {
            if (outputStopDebounceRef.current) {
              clearTimeout(outputStopDebounceRef.current);
              outputStopDebounceRef.current = null;
            }
            if (activeRef.current) setState("listening");
          } else {
            if (outputStopDebounceRef.current) clearTimeout(outputStopDebounceRef.current);
            outputStopDebounceRef.current = setTimeout(() => {
              outputStopDebounceRef.current = null;
              if (activeRef.current && !assistantSpeakingRef.current) {
                setState("listening");
              }
            }, OUTPUT_STOP_DEBOUNCE_MS);
          }
          break;
        }

        case "response.done": {
          const doneAt = Date.now();
          const t = turnTimingRef.current;
          assistantResponseActiveRef.current = false;
          assistantSpeakingRef.current = false;
          clearBargeInTimer();
          // response.done is the authoritative end of the reply: cancel any pending
          // stop debounce and flip to "listening" without flicker.
          if (outputStopDebounceRef.current) {
            clearTimeout(outputStopDebounceRef.current);
            outputStopDebounceRef.current = null;
          }
          if (thinkingWatchdogRef.current) {
            clearTimeout(thinkingWatchdogRef.current);
            thinkingWatchdogRef.current = null;
          }
          // Refresh the focus window so the user can follow up naturally right
          // after Ora finishes speaking — casual replies like "that's great" or
          // "continue" pass the focus filter within FOCUS_FOLLOWUP_WINDOW_MS of
          // this moment without requiring a wake word.
          lastAcceptedUserTurnAtRef.current = Date.now();
          logVoiceDiag("response_done", {
            output_cycles: t.outputCycles,
            output_stopped_to_response_done_ms: deltaMs(t.outputStoppedAt, doneAt),
            speech_stopped_to_response_done_ms: deltaMs(t.speechStoppedAt, doneAt),
          });
          recordDiag("response.done", { output_cycles: t.outputCycles });
          // A clean reply finished: the turn completed normally, so clear any
          // instability signal accrued during the reply.
          noteAudioProgress();
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
        }

        case "error": {
          const message =
            (typeof evt.error === "object" &&
              evt.error &&
              typeof (evt.error as { message?: string }).message === "string" &&
              (evt.error as { message?: string }).message) ||
            "";
          logVoiceDiag("model_error", { message: message || "unknown" });
          recordDiag("response.error", { message: message || "unknown" });
          // If a model error arrives while we are mid-response (thinking or
          // speaking), response.done may never follow. Clear the active-response
          // flags and recover to "listening" so the user is never stranded. The
          // session stays open — the next accepted turn starts a new response.
          if (assistantResponseActiveRef.current || assistantSpeakingRef.current) {
            assistantResponseActiveRef.current = false;
            assistantSpeakingRef.current = false;
            if (thinkingWatchdogRef.current) {
              clearTimeout(thinkingWatchdogRef.current);
              thinkingWatchdogRef.current = null;
            }
            if (outputStopDebounceRef.current) {
              clearTimeout(outputStopDebounceRef.current);
              outputStopDebounceRef.current = null;
            }
            if (activeRef.current) setState("listening");
          }
          break;
        }
        default:
          break;
      }
    },
    [confirmBargeIn, cancelPendingBargeIn, clearBargeInTimer, bargeInRequiresDirection, sendEvent],
  );

  // ── Start ────────────────────────────────────────────────────────────────
  const start = useCallback(
    async (
      ctx: RealtimeStartContext,
      opts?: { isReconnect?: boolean },
    ): Promise<{ started: boolean; reason: string | null; overLimit?: boolean }> => {
      const isReconnect = opts?.isReconnect === true;
      // Remember the last context so an auto-reconnect or the Retry button can
      // rebuild the session without the caller re-supplying it.
      lastCtxRef.current = ctx;
      // A fresh, user-initiated start resets the single-attempt reconnect budget
      // and clears any prior instability/quality state. A reconnect keeps the
      // budget consumed so a second drop routes straight to legacy.
      if (!isReconnect) {
        reconnectAttemptedRef.current = false;
        reconnectConsumedRef.current = false;
        setConnectionIssue(false);
        applyNetworkQuality("good");
        audioStopTimestampsRef.current = [];
      }
      const mod = loadWebRTC();
      if (!isSupported || !mod) {
        const reason = "Live voice isn't available on this app version. Using basic voice mode.";
        setState("unsupported");
        setFallbackReason(reason);
        return { started: false, reason };
      }
      if (activeRef.current) fullTeardown();

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
      acceptedUserTurnCountRef.current = 0;
      setIsMuted(false);
      mutedRef.current = false;
      setOverLimit(null);
      setState("connecting");
      activeRef.current = true;
      // Capture this start()'s generation. fullTeardown() (stop / context switch /
      // background / duration cap / ICE drop / unmount) increments the shared
      // counter, so isCurrent() goes false the instant this attempt is superseded.
      const myGen = ++startGenerationRef.current;
      const isCurrent = () => startGenerationRef.current === myGen;
      // Release ONLY this attempt's own resources. A superseded start must never
      // call the shared fullTeardown() or null the shared refs: a newer session may
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
          voicePreset: ctx.voicePreset,
        });
      } catch (err) {
        // Superseded/cancelled while minting: a newer start()/fullTeardown() took
        // over. Nothing is allocated yet, so bail quietly without touching shared
        // state (which a newer session may now own).
        if (!isCurrent()) return { started: false, reason: null };
        activeRef.current = false;
        // Budget exhausted (429 realtime_voice_minutes) or a concurrent session
        // (409 realtime_voice_concurrent): do NOT fall back to the legacy loop,
        // which would bypass the per-plan voice cap. Surface a graceful "out of
        // voice time" state and signal overLimit so the caller exits Talk mode
        // instead of restarting the metered loop.
        if (err instanceof ApiRequestError) {
          const eb = (err.body && typeof err.body === "object" ? err.body : {}) as {
            error?: string;
            limitType?: string;
            upgradeAvailable?: boolean;
            resetAt?: string | null;
            resetsAt?: string | null;
          };
          if (err.status === 429 && eb.limitType === "realtime_voice_minutes") {
            logVoiceDiag("realtime_over_limit", { limit_type: eb.limitType });
            setOverLimit({
              message:
                typeof eb.error === "string"
                  ? eb.error
                  : "You've used all your live voice time for now. It refreshes later — you can keep chatting with Ora by text in the meantime.",
              resetsAt: eb.resetAt ?? eb.resetsAt ?? null,
              upgradeAvailable: eb.upgradeAvailable ?? false,
            });
            setState("ended");
            return { started: false, reason: null, overLimit: true };
          }
          if (err.status === 409 && eb.limitType === "realtime_voice_concurrent") {
            logVoiceDiag("realtime_concurrent", { limit_type: eb.limitType });
            setOverLimit({
              message:
                typeof eb.error === "string"
                  ? eb.error
                  : "Live voice is already active on another device or tab.",
              resetsAt: null,
              upgradeAvailable: false,
            });
            setState("ended");
            return { started: false, reason: null, overLimit: true };
          }
        }
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
      // fullTeardown — a newer session may own the shared state; no fallback warning).
      if (!isCurrent()) return { started: false, reason: null };

      if (!mint.value) {
        activeRef.current = false;
        setState("idle");
        const reason = "Live voice failed to start. Using basic voice mode.";
        setFallbackReason(reason);
        return { started: false, reason };
      }

      // Own the iOS audio session for the realtime call BEFORE capturing the mic.
      // expo-audio's allowsRecording:true maps to the .playAndRecord category; the
      // legacy transcribe/speak paths use .playback (allowsRecording:false), and if
      // one of those lands here the mic captures silence — Ora never hears the user
      // and never replies. Best-effort: a failure must not abort the call.
      try {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      } catch {
        /* non-fatal: getUserMedia may still succeed */
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
          // Only the current generation may react. A stale connection's ICE change
          // must never tear down or reconnect a newer session.
          if ((st === "failed" || st === "disconnected") && isCurrent() && activeRef.current) {
            recordDiag("ice_state", { state: st });
            handleConnectionDrop("Live voice connection dropped.");
          }
        });

        activePc.addEventListener("connectionstatechange", () => {
          const st = activePc.connectionState;
          if ((st === "failed" || st === "disconnected") && isCurrent() && activeRef.current) {
            recordDiag("pc_state", { state: st });
            handleConnectionDrop("Live voice connection lost.");
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
          recordDiag("datachannel.open");
          if (activeRef.current) setState("listening");
        });
        dc.addEventListener("close", () => {
          if (!isCurrent() || !activeRef.current) return;
          recordDiag("datachannel.close");
          handleConnectionDrop("Live voice channel closed.");
        });
        dc.addEventListener("error", () => {
          if (!isCurrent() || !activeRef.current) return;
          recordDiag("datachannel.error");
          handleConnectionDrop("Live voice channel error.");
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
          fullTeardown();
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

        // Remember the session for budget metering: the heartbeat charges elapsed
        // seconds and the /end beacon finalizes the charge. The server clock is
        // authoritative; these client marks only drive the local countdown.
        realtimeSessionIdRef.current = mint.realtimeSessionId ?? null;
        sessionStartedAtRef.current = Date.now();
        logVoiceDiag("session_started", {
          max_duration_seconds: Math.max(0, Math.floor(mint.maxDurationSeconds || 0)),
          remaining_seconds:
            typeof mint.remainingSeconds === "number" ? mint.remainingSeconds : null,
          limit_seconds: typeof mint.limitSeconds === "number" ? mint.limitSeconds : null,
        });

        // Duration cap — the server cannot meter audio once the token is live, so
        // the client counts down from maxDurationSeconds (= min(remaining budget,
        // per-session cap)) and auto-ends at zero. The heartbeat re-syncs this to
        // the server budget so it never drifts above the real remaining minutes.
        const cap = Math.max(0, Math.floor(mint.maxDurationSeconds || 0));
        if (cap > 0) {
          setRemainingSeconds(cap);
          durationTimerRef.current = setInterval(() => {
            setRemainingSeconds((prev) => {
              if (prev == null) return prev;
              const nextVal = prev - 1;
              // One-time "running low" signal (privacy-safe: seconds only). Fires
              // naturally once as the 1s countdown crosses the threshold.
              if (nextVal === LOW_TIME_WARNING_SECONDS) {
                logVoiceDiag("low_time_warning", { remaining_seconds: nextVal });
              }
              if (nextVal <= 0) {
                clearDurationTimer();
                fullTeardown();
                setInterimUserTranscript("");
                setInterimAssistantTranscript("");
                setState("ended");
                return 0;
              }
              return nextVal;
            });
          }, 1000);
        }

        // Heartbeat: charge elapsed seconds to the per-plan budget on a cadence
        // (server-specified, else the default). Skipped when the mint did not
        // return a session id (older server) so metering simply no-ops.
        if (realtimeSessionIdRef.current) {
          const beatSeconds =
            typeof mint.heartbeatIntervalSeconds === "number" && mint.heartbeatIntervalSeconds > 0
              ? mint.heartbeatIntervalSeconds
              : DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
          heartbeatTimerRef.current = setInterval(() => {
            void sendHeartbeat();
          }, beatSeconds * 1000);
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
        fullTeardown();
        setState("idle");
        const reason = "Live voice failed to start. Using basic voice mode.";
        setFallbackReason(reason);
        return { started: false, reason };
      }
    },
    [
      isSupported,
      fullTeardown,
      handleConnectionDrop,
      handleServerEvent,
      clearDurationTimer,
      sendEvent,
      clearBargeInTimer,
      sendHeartbeat,
    ],
  );

  // Expose start() to the reconnect helpers (declared above start) through the ref.
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Manual recovery from the legacy-fallback state: reset the single-attempt
  // reconnect budget and rebuild the realtime session from the last context.
  const retry = useCallback(() => {
    const ctx = lastCtxRef.current;
    if (!ctx) return;
    recordDiag("manual_retry");
    reconnectAttemptedRef.current = false;
    reconnectConsumedRef.current = false;
    setConnectionIssue(false);
    void start(ctx);
  }, [start, recordDiag]);

  // NetInfo-triggered fast reconnect: when connectivity returns while a reconnect
  // is pending its backoff timer, fire it immediately instead of waiting out the
  // full delay. The one-shot guard inside fire() keeps this to a single attempt.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((netState) => {
      const online = netState.isConnected === true && netState.isInternetReachable !== false;
      if (!online) return;
      const fire = pendingReconnectFireRef.current;
      if (fire) {
        recordDiag("netinfo_reconnect_trigger");
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        fire();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [recordDiag]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      fullTeardown();
    };
  }, [fullTeardown]);

  return {
    state,
    isSupported,
    error,
    fallbackReason,
    isMuted,
    interimUserTranscript,
    interimAssistantTranscript,
    remainingSeconds,
    overLimit,
    networkQuality,
    connectionIssue,
    start,
    stop,
    interrupt,
    toggleMute,
    retry,
  };
}
