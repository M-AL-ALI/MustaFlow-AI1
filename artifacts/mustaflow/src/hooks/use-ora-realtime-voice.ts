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

/**
 * Derived connection-quality signal for the live-voice UI dot:
 * - "good": connected and healthy
 * - "degraded": connected but showing instability
 * - "reconnecting": the single automatic recovery attempt is in flight
 * - "legacy": realtime gave up; the legacy transcribe -> chat -> tts loop is active
 */
export type NetworkQuality = "good" | "degraded" | "reconnecting" | "legacy";

/**
 * Surfaced when the per-plan live-voice MINUTE budget is exhausted (at session
 * start, or mid-call when the budget runs out). The caller shows a graceful
 * "out of voice time" state with the reset time INSTEAD of falling back to the
 * legacy transcribe -> chat -> tts loop, which would bypass the voice cap.
 */
export interface RealtimeOverLimit {
  /** Short, spoken-budget-safe message (no provider/model naming). */
  message: string;
  /** ISO timestamp when the voice budget refills, when known. */
  resetsAt: string | null;
  /** True when a higher plan would grant more live-voice minutes. */
  upgradeAvailable: boolean;
}

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
  /**
   * Speaker-focus mode for this session. "focused" (default) makes the server
   * stop auto-responding so the client only replies to transcripts that clear the
   * focus filter (rejecting nearby background speakers). "normal" keeps the legacy
   * open behavior. When omitted, the persisted preference is used.
   */
  focusMode?: FocusMode;
  /**
   * Product voice for the spoken reply ("marine" = female, "mustafa" = male).
   * When omitted, the persisted preference is used. The server maps this to the
   * underlying provider voice; the raw provider id is never exposed to the client.
   */
  voicePreset?: VoicePreset;
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
   * Set when the per-plan live-voice budget is exhausted (at start or mid-call).
   * The caller shows a graceful "out of voice time" state with the reset time
   * instead of falling back to the legacy loop (which would bypass the cap).
   */
  overLimit: RealtimeOverLimit | null;
  /** Derived connection-quality signal driving the live-voice status dot. */
  networkQuality: NetworkQuality;
  /**
   * Begin a realtime session. Resolves true when connected, false when the
   * session could not start (in which case fallbackReason is set). Must be
   * called from inside a user gesture so audio autoplay is unlocked. The optional
   * `isReconnect` flag marks the single automatic recovery attempt so it does not
   * reset the one-attempt budget.
   */
  start: (ctx: RealtimeStartContext, opts?: { isReconnect?: boolean }) => Promise<boolean>;
  /** End the session and release the mic, peer connection, and audio element. */
  stop: () => void;
  /** Barge-in: cancel Ora's current response and clear queued output audio. */
  interrupt: () => void;
  /** Toggle muting of Ora's spoken audio (does not stop the mic). */
  toggleMute: () => void;
  /**
   * Manual recovery from the legacy-fallback state: reset the single-attempt
   * reconnect budget and rebuild the realtime session from the last context.
   */
  retry: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MINT_URL = "/api/public-ai/realtime/session";
const HEARTBEAT_URL = "/api/public-ai/realtime/heartbeat";
const END_URL = "/api/public-ai/realtime/end";
const DATA_CHANNEL_NAME = "oai-events";
const SDP_TIMEOUT_MS = 15_000;
// How often to beat the live-voice budget when the server does not specify a
// cadence. Each beat charges elapsed seconds and re-syncs the remaining time.
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
// Below this many seconds left, the countdown UI shows a "running low" warning.
// Exported so the conversation view uses the SAME threshold as the hook diag.
export const LOW_TIME_WARNING_SECONDS = 60;

// ─── Voice-stability tuning (mirrored in the mobile hook) ────────────────────
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
// Poor-network resilience: how long to wait before the SINGLE automatic reconnect
// attempt fires after a mid-call drop.
const RECONNECT_DELAY_MS = 2000;
// Diagnostics ring buffer size — the last N connection events, kept in memory only
// to derive UI state / optional debug logs. Never sent to a server.
const DIAG_RING_SIZE = 20;
// If the state remains "thinking" for this long without Ora starting to speak
// or response.done arriving, assume the event was lost and recover to
// "listening". 15 s sits comfortably above real model latency while preventing
// an indefinite stuck state caused by a dropped data-channel message.
const THINKING_WATCHDOG_MS = 15_000;

// ─── Transcript validity filter (mirrored in the mobile hook) ────────────────
// Pure + surface-agnostic. Keep BYTE-FOR-BYTE identical to the copy in
// artifacts/ora-mobile/hooks/useOraRealtimeVoiceNative.ts so both surfaces accept
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

// ─── Speaker-focus filter (mirrored in the mobile hook) ──────────────────────
// Layered ON TOP of validateUserTranscript and used ONLY in "focused" mode (the
// default). In focused mode the server does not auto-respond, so the client only
// asks Ora to reply for transcripts that clear this filter — which is what keeps
// Ora from answering nearby background speakers. Pure + surface-agnostic: keep
// BYTE-FOR-BYTE identical to the copy in
// artifacts/ora-mobile/hooks/useOraRealtimeVoiceNative.ts.

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

// ─── Web-only focus-mode persistence (NOT part of the byte-identical block) ──
// The mobile hook persists the same preference via AsyncStorage instead.
export const VOICE_FOCUS_STORAGE_KEY = "mustaflow_voice_focus";

/** Read the persisted speaker-focus preference; defaults to "focused". */
export function readStoredFocusMode(): FocusMode {
  if (typeof window === "undefined") return "focused";
  try {
    return window.localStorage.getItem(VOICE_FOCUS_STORAGE_KEY) === "normal" ? "normal" : "focused";
  } catch {
    return "focused";
  }
}

// ─── Web-only product-voice persistence (NOT part of the byte-identical block) ──
// Marine (female) / Mustafa (male). Persisted per-browser via localStorage; the
// server maps the preset to the underlying provider voice and never returns the
// raw provider voice id. The mobile hook persists the same preference via
// AsyncStorage instead.
export type VoicePreset = "marine" | "mustafa";

export const VOICE_PRESET_STORAGE_KEY = "mustaflow_voice_preset";

export const DEFAULT_VOICE_PRESET: VoicePreset = "marine";

/** Display labels for the product voices. */
export const VOICE_PRESET_LABELS: Record<VoicePreset, string> = {
  marine: "Marine",
  mustafa: "Mustafa",
};

/** Read the persisted product-voice preference; defaults to "marine". */
export function getStoredVoicePreset(): VoicePreset {
  if (typeof window === "undefined") return DEFAULT_VOICE_PRESET;
  try {
    return window.localStorage.getItem(VOICE_PRESET_STORAGE_KEY) === "mustafa"
      ? "mustafa"
      : "marine";
  } catch {
    return DEFAULT_VOICE_PRESET;
  }
}

/** Persist the product-voice preference for this browser. Best-effort. */
export function writeStoredVoicePreset(preset: VoicePreset): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOICE_PRESET_STORAGE_KEY, preset);
  } catch {
    /* localStorage unavailable — keep the in-memory choice. */
  }
}

/**
 * Structured, privacy-safe realtime voice diagnostics. Emits event names, counts,
 * reasons, and the selected language — NEVER raw audio or full transcript text —
 * so barge-in / transcript-filter decisions can be inspected in the console.
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

interface MintResponse {
  value: string;
  expiresAt: number | null;
  model: string;
  // The server no longer echoes the raw provider voice id; it returns the
  // product preset + label instead. `voice` is kept optional only for back-compat.
  voice?: string;
  voicePreset?: VoicePreset | null;
  voiceLabel?: string;
  maxDurationSeconds: number;
  // Echoed back by the server so diagnostics can confirm the negotiated posture.
  focusMode?: FocusMode;
  createResponse?: boolean;
  // Live-voice budget metering. The client stores realtimeSessionId, beats it on
  // heartbeatIntervalSeconds, counts down from maxDurationSeconds, and finalizes
  // at /end. resetsAt is when the per-plan budget refills.
  realtimeSessionId?: string;
  remainingSeconds?: number | null;
  limitSeconds?: number | null;
  resetsAt?: string | null;
  heartbeatIntervalSeconds?: number | null;
}

// ─── Feature detection ────────────────────────────────────────────────────────

function detectSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    // getUserMedia requires a secure context (https / localhost).
    window.isSecureContext === true &&
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
  const [overLimit, setOverLimit] = useState<RealtimeOverLimit | null>(null);
  // Derived connection-quality signal for the status dot. "good" while healthy;
  // "degraded"/"reconnecting"/"legacy" as resilience state changes.
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>("good");

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
  // Live-voice budget metering: the active session id (from the mint), the
  // heartbeat interval, and the epoch ms the session connected (client-measured
  // duration the heartbeat/end report; the server clock stays authoritative).
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const realtimeSessionIdRef = useRef<string | null>(null);
  const sessionStartedAtRef = useRef(0);
  const sdpAbortRef = useRef<AbortController | null>(null);
  // Accumulators for the in-flight turn's final transcript text. The GA API may
  // send the final text either as a single "done" payload or only as deltas, so
  // we accumulate deltas and prefer an explicit final string when present.
  const userTextRef = useRef("");
  const assistantTextRef = useRef("");
  // Guards against double-fullTeardown firing the duration/ICE handlers after stop.
  const activeRef = useRef(false);

  // ── Poor-network resilience ───────────────────────────────────────────────
  // In-memory diagnostics ring buffer: the last DIAG_RING_SIZE connection events.
  // Kept only to derive UI state / optional debug logs; never sent to a server.
  const diagRef = useRef<Array<{ t: number; event: string; detail?: unknown }>>([]);
  // Mirror of networkQuality for use inside stable callbacks/handlers.
  const networkQualityRef = useRef<NetworkQuality>("good");
  // The single-auto-reconnect budget: `attempted` flips once the one recovery try
  // is scheduled and never resets until a fresh (non-reconnect) start() or retry().
  const reconnectAttemptedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last context passed to start(), so the auto-reconnect / retry can rebuild the
  // session with the same language/focus/voice/history.
  const lastCtxRef = useRef<RealtimeStartContext | null>(null);
  // Forward ref so pre-declaration helpers can call start() (defined later).
  const startRef = useRef<
    ((ctx: RealtimeStartContext, opts?: { isReconnect?: boolean }) => Promise<boolean>) | null
  >(null);

  // ── Barge-in confirmation + transcript-quality guards ─────────────────────
  // assistantResponseActiveRef: Ora has a response in flight (response.created ->
  // response.done), even before its first audio frame. assistantSpeakingRef: Ora
  // audio is actually playing. A barge-in is only meaningful while one is true, so
  // checking BOTH catches an interruption in the generation-to-first-audio window.
  const assistantResponseActiveRef = useRef(false);
  const assistantSpeakingRef = useRef(false);
  // A speech_started fired while Ora was active and is awaiting confirmation.
  const pendingBargeInRef = useRef(false);
  const bargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp (ms) of the last assistant audio start/stop, for the echo window.
  const lastAssistantAudioAtRef = useRef(0);
  // Timestamp (ms) of the last client-initiated cancel, so a server-driven output
  // clear (e.g. server VAD interrupt_response) can be told apart in diagnostics.
  const clientCancelledAtRef = useRef(0);
  // Ora's most recent finalized spoken text, for the echo-overlap check.
  const recentAssistantSpeechRef = useRef("");
  // The reply language selected at session start ("auto" when unset), for diag.
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
  // finalizes the charge now instead of waiting for stale-session expiry. Uses
  // keepalive so the request still flushes during page-hide/unload. The server
  // clock is authoritative and stale expiry is the safety net if this never
  // lands, so this never blocks fullTeardown and never throws.
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
      void authFetch(END_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realtimeSessionId: id, durationSeconds }),
        keepalive: true,
      }).catch(() => {
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

  // In focused mode, automatic barge-in is intentionally stricter than turn
  // acceptance. If Ora is already speaking, only addressed/directed speech may
  // stop her; otherwise nearby conversation inside the follow-up window can still
  // chop Ora mid-sentence. The manual Interrupt button remains immediate.
  const bargeInRequiresDirection = useCallback(() => focusModeRef.current === "focused", []);

  // Append a connection event to the in-memory ring buffer (last DIAG_RING_SIZE).
  const recordDiag = useCallback((event: string, detail?: unknown) => {
    const ring = diagRef.current;
    ring.push({ t: Date.now(), event, detail });
    if (ring.length > DIAG_RING_SIZE) ring.splice(0, ring.length - DIAG_RING_SIZE);
    logVoiceDiag("net_diag", { event, ...(detail && typeof detail === "object" ? detail : {}) });
  }, []);

  // Set the derived network-quality signal (state + mirror ref together).
  const applyNetworkQuality = useCallback((q: NetworkQuality) => {
    networkQualityRef.current = q;
    setNetworkQuality(q);
  }, []);

  const fullTeardown = useCallback(() => {
    activeRef.current = false;
    clearDurationTimer();
    clearHeartbeatTimer();
    clearBargeInTimer();
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
        dc.onmessage = null;
        dc.onopen = null;
        dc.onclose = null;
        dc.onerror = null;
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
  }, [clearDurationTimer, clearHeartbeatTimer, clearBargeInTimer, finalizeSession]);

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

  // Give up on realtime and hand control to the legacy transcribe -> chat -> tts
  // loop. This does NOT alter the legacy implementation; it only tears down the
  // realtime session and notifies the caller (which owns the legacy loop).
  const enterLegacyFallback = useCallback(
    (reason: string) => {
      recordDiag("legacy_fallback", { reason });
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      fullTeardown();
      applyNetworkQuality("legacy");
      setState("idle");
      setFallbackReason(reason);
      onFallbackRef.current?.(reason);
    },
    [recordDiag, fullTeardown, applyNetworkQuality],
  );

  // Schedule the SINGLE automatic reconnect attempt after a mid-call drop. If the
  // one-attempt budget is already spent, drop straight to the legacy fallback.
  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptedRef.current) {
      enterLegacyFallback("Live voice connection dropped. Using basic voice mode.");
      return;
    }
    const ctx = lastCtxRef.current;
    if (!ctx) {
      enterLegacyFallback("Live voice connection dropped. Using basic voice mode.");
      return;
    }
    reconnectAttemptedRef.current = true;
    recordDiag("reconnect_scheduled", { delayMs: RECONNECT_DELAY_MS });
    applyNetworkQuality("reconnecting");
    setState("connecting");
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      recordDiag("reconnect_attempt");
      void (async () => {
        const started = await startRef.current?.(ctx, { isReconnect: true });
        if (!started) {
          enterLegacyFallback("Live voice reconnect failed. Using basic voice mode.");
        }
      })();
    }, RECONNECT_DELAY_MS);
  }, [enterLegacyFallback, recordDiag, applyNetworkQuality]);

  // Central handler for a mid-call connection drop (ICE failed/disconnected, data
  // channel close/error, or connectionstatechange failed). Runs the one auto
  // retry, then the legacy fallback.
  const handleConnectionDrop = useCallback(
    (source: string) => {
      if (!activeRef.current) return;
      recordDiag("connection_drop", { source });
      applyNetworkQuality("degraded");
      // Tear down the broken session but keep the caller in the realtime UI while
      // the single reconnect attempt runs.
      fullTeardown();
      scheduleReconnect();
    },
    [recordDiag, applyNetworkQuality, fullTeardown, scheduleReconnect],
  );

  // Manual recovery from the legacy-fallback state: reset the one-attempt budget
  // and rebuild the realtime session from the last known context.
  const retry = useCallback(() => {
    const ctx = lastCtxRef.current;
    if (!ctx) return;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptedRef.current = false;
    recordDiag("manual_retry");
    applyNetworkQuality("reconnecting");
    setState("connecting");
    setFallbackReason(null);
    setError(null);
    void (async () => {
      const started = await startRef.current?.(ctx);
      if (!started) {
        enterLegacyFallback("Live voice reconnect failed. Using basic voice mode.");
      }
    })();
  }, [recordDiag, applyNetworkQuality, enterLegacyFallback]);

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

  // Heartbeat: periodically charge elapsed seconds to the per-plan live-voice
  // budget and re-sync the remaining time. On budget exhaustion the call ends
  // gracefully with a reset message; on a fail-closed metering outage it drops to
  // the legacy loop. A single failed beat is tolerated (the next beat or the
  // server's stale-session expiry reconciles) so a network blip never ends a
  // call. Reports ONLY the session id + elapsed seconds — never audio/transcript.
  const sendHeartbeat = useCallback(async () => {
    const id = realtimeSessionIdRef.current;
    if (!id) return;
    const durationSeconds =
      sessionStartedAtRef.current > 0
        ? Math.max(0, Math.floor((Date.now() - sessionStartedAtRef.current) / 1000))
        : 0;

    type HeartbeatBody = {
      status?: string;
      ended?: boolean;
      remainingSeconds?: number | null;
      limitSeconds?: number | null;
      resetsAt?: string | null;
    };
    let body: HeartbeatBody | null = null;
    // Assigned in the try below; the catch returns, so both are definitely set
    // before any read. No initializer (it would be dead — see no-useless-assignment).
    let httpStatus: number;
    let httpOk: boolean;
    try {
      const resp = await authFetch(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realtimeSessionId: id, durationSeconds }),
      });
      httpStatus = resp.status;
      httpOk = resp.ok;
      try {
        body = (await resp.json()) as HeartbeatBody;
      } catch {
        /* tolerate an empty/non-JSON body */
      }
    } catch {
      // Network blip — do NOT end the call. The next beat (or stale-session
      // expiry on the server) reconciles the charge.
      logVoiceDiag("heartbeat_network_error");
      return;
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

  const stopAssistantOutput = useCallback(() => {
    clientCancelledAtRef.current = Date.now();
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
    assistantResponseActiveRef.current = false;
    assistantSpeakingRef.current = false;
    setInterimAssistantTranscript("");
    assistantTextRef.current = "";
  }, [sendEvent]);

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
      const audioEl = audioElRef.current;
      // Output-only: mute Ora's playback. The mic track stays live so Ora keeps
      // hearing the user even while muted (matching the fallback mute control).
      if (audioEl) audioEl.muted = next;
      return next;
    });
  }, []);

  // ── Data-channel event handling ──────────────────────────────────────────
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
        // ── User speech / input transcription ──────────────────────────────
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
            // real interruption — confirm immediately so Ora stops fast. When
            // barge-in is gated (focused mode, outside the window) only an
            // addressed/directed partial may interrupt Ora.
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
          // Drop a late finalized transcript that lands after fullTeardown so it can
          // never write into a session that already ended.
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

        // ── Assistant response lifecycle ───────────────────────────────────
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

        // Assistant spoken-transcript deltas. Handle GA names plus older aliases.
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

        // ── WebRTC output-audio playback markers ───────────────────────────
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
          if (t.outputCycles === 1) {
            t.outputStartedAt = now;
            logVoiceDiag("output_audio_started", {
              response_created_to_output_started_ms: deltaMs(t.responseCreatedAt, now),
            });
          } else {
            logVoiceDiag("output_audio_restarted", { output_cycles: t.outputCycles });
          }
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
          // Flush any assistant text that only arrived via deltas (no explicit
          // done payload) so the turn is never dropped.
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
    async (ctx: RealtimeStartContext, opts?: { isReconnect?: boolean }): Promise<boolean> => {
      if (!isSupported) {
        setState("unsupported");
        setFallbackReason("This browser does not support live voice. Using basic voice mode.");
        return false;
      }
      // Never stack two sessions.
      if (activeRef.current) fullTeardown();

      // Remember the context so the single auto-reconnect / manual retry can
      // rebuild with the same language/focus/voice/history. A fresh (user-driven)
      // start resets the one-attempt reconnect budget; a reconnect must NOT.
      lastCtxRef.current = ctx;
      if (!opts?.isReconnect) {
        reconnectAttemptedRef.current = false;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        applyNetworkQuality("good");
      }
      recordDiag(opts?.isReconnect ? "start_reconnect" : "start");

      setError(null);
      setFallbackReason(null);
      setOverLimit(null);
      setInterimUserTranscript("");
      setInterimAssistantTranscript("");
      userTextRef.current = "";
      assistantTextRef.current = "";
      // Remember the language chosen at mint so diagnostics report the intended
      // language. The session sets the spoken language ONCE here; rejected/noisy
      // transcripts can never re-derive or drift it mid-call.
      selectedLanguageRef.current = ctx.language || "auto";
      // Resolve the speaker-focus posture once, at session start. Explicit ctx wins;
      // otherwise fall back to the persisted preference (default "focused").
      const focusMode = ctx.focusMode ?? readStoredFocusMode();
      focusModeRef.current = focusMode;
      // Resolve the product voice once, at session start. Explicit ctx wins;
      // otherwise fall back to the persisted preference (default "marine").
      const voicePreset = ctx.voicePreset ?? getStoredVoicePreset();
      // Opening Talk to Ora is an explicit address: seed the focus window so the
      // user's first utterance is treated as engaged (no wake word required).
      lastAcceptedUserTurnAtRef.current = Date.now();
      acceptedUserTurnCountRef.current = 0;
      assistantResponseActiveRef.current = false;
      assistantSpeakingRef.current = false;
      recentAssistantSpeechRef.current = "";
      lastAssistantAudioAtRef.current = 0;
      clientCancelledAtRef.current = 0;
      clearBargeInTimer();
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
            focusMode,
            voicePreset,
          }),
        });
        if (!resp.ok) {
          let reason = "Live voice is unavailable right now. Using basic voice mode.";
          type MintErrorBody = {
            error?: string;
            limitType?: string;
            upgradeAvailable?: boolean;
            resetAt?: string | null;
            resetsAt?: string | null;
          };
          let body: MintErrorBody | null = null;
          try {
            body = (await resp.json()) as MintErrorBody;
            if (body?.error) reason = body.error;
          } catch {
            /* ignore parse failure */
          }
          // Budget exhausted (429 realtime_voice_minutes) or a concurrent session
          // (409 realtime_voice_concurrent): do NOT fall back to the legacy loop,
          // which would bypass the per-plan voice cap. Surface a graceful state
          // and keep the realtime UI (return true so the caller does not flip to
          // the fallback transport).
          if (resp.status === 429 && body?.limitType === "realtime_voice_minutes") {
            activeRef.current = false;
            logVoiceDiag("realtime_over_limit", { limit_type: body.limitType });
            setOverLimit({
              message: reason,
              resetsAt: body?.resetAt ?? body?.resetsAt ?? null,
              upgradeAvailable: body?.upgradeAvailable ?? false,
            });
            setState("ended");
            return true;
          }
          if (resp.status === 409 && body?.limitType === "realtime_voice_concurrent") {
            activeRef.current = false;
            logVoiceDiag("realtime_concurrent", { limit_type: body.limitType });
            setOverLimit({ message: reason, resetsAt: null, upgradeAvailable: false });
            setState("ended");
            return true;
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
          if (st === "connected" || st === "completed") {
            // A healthy ICE state clears any lingering "degraded" signal.
            if (activeRef.current && networkQualityRef.current !== "good") {
              applyNetworkQuality("good");
              recordDiag("ice_recovered", { state: st });
            }
            return;
          }
          if ((st === "failed" || st === "disconnected") && activeRef.current) {
            // Mid-call drop: run the single auto-reconnect, then legacy fallback.
            // (start() already resolved true, so the caller is in the realtime UI;
            // the start()-false path cannot cover a mid-call drop.)
            handleConnectionDrop(`ice_${st}`);
          }
        };

        pc.onconnectionstatechange = () => {
          const st = pc.connectionState;
          if (st === "failed" && activeRef.current) {
            handleConnectionDrop("pc_failed");
          }
        };

        const micTrack = stream.getAudioTracks()[0];
        if (micTrack) pc.addTrack(micTrack, stream);

        // Data channel for transcripts + control events.
        const dc = pc.createDataChannel(DATA_CHANNEL_NAME);
        dcRef.current = dc;
        dc.onmessage = (e) => handleServerEvent(typeof e.data === "string" ? e.data : "");
        dc.onclose = () => {
          if (activeRef.current) handleConnectionDrop("dc_close");
        };
        dc.onerror = () => {
          if (activeRef.current) handleConnectionDrop("dc_error");
        };
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
          fullTeardown();
          setState("idle");
          setFallbackReason("Live voice failed to connect. Using basic voice mode.");
          return false;
        }
        sdpAbortRef.current = null;

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

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
                // Auto-end at the cap; not a fallback, just a graceful stop. The
                // heartbeat/end charge the elapsed minutes; fullTeardown fires /end.
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

        // Connected: clear any "reconnecting"/"degraded" signal from a prior drop.
        applyNetworkQuality("good");
        recordDiag("connected", { isReconnect: opts?.isReconnect === true });
        return true;
      } catch {
        fullTeardown();
        setState("idle");
        setFallbackReason("Live voice failed to start. Using basic voice mode.");
        return false;
      }
    },
    [
      isSupported,
      fullTeardown,
      handleConnectionDrop,
      handleServerEvent,
      clearDurationTimer,
      sendEvent,
      sendHeartbeat,
      clearBargeInTimer,
      applyNetworkQuality,
      recordDiag,
    ],
  );

  // Keep the forward ref current so pre-declaration helpers (auto-reconnect /
  // retry) always call the latest start().
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      fullTeardown();
    };
  }, [fullTeardown]);

  // Poor-network resilience (web): when the browser regains connectivity after an
  // offline blip that dropped the call to legacy, allow one immediate recovery
  // attempt. Mirrors the mobile NetInfo trigger without a native dependency.
  useEffect(() => {
    const onOnline = () => {
      if (networkQualityRef.current === "reconnecting" && lastCtxRef.current) {
        recordDiag("browser_online_retry");
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        void (async () => {
          const started = await startRef.current?.(lastCtxRef.current!, { isReconnect: true });
          if (!started) {
            enterLegacyFallback("Live voice reconnect failed. Using basic voice mode.");
          }
        })();
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [recordDiag, enterLegacyFallback]);

  // Page-hide / tab-close: finalize the live-voice session so its minutes are
  // charged promptly (a closed tab never runs the normal fullTeardown). keepalive in
  // finalizeSession lets the request flush during unload; stale-session expiry is
  // the safety net if it does not. Only `pagehide` (true unload) ends the call —
  // a mere `visibilitychange` (tab switch) must keep the live call running.
  useEffect(() => {
    const onPageHide = () => {
      if (realtimeSessionIdRef.current) finalizeSession();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [finalizeSession]);

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
    start,
    stop,
    interrupt,
    toggleMute,
    retry,
  };
}
