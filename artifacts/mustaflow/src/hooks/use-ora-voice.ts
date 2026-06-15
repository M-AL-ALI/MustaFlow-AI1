/**
 * Voice-A: browser-native SpeechRecognition + speechSynthesis.
 *
 * Design rules:
 * - Review-before-send: final transcript lands in the caller's input box; caller decides when to send.
 * - TTS defaults OFF; stored in sessionStorage under "ora_tts_enabled".
 * - Voice gender defaults to female; URI stored in localStorage under "ora_voice_uri".
 * - No audio is stored permanently. No transcript text is logged anywhere.
 * - Spoken replies use the server TTS route (/api/public-ai/tts) for a
 *   high-quality voice; speech recognition stays browser-native.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/api-fetch";

// ─── Minimal inline Speech API declarations ───────────────────────────────────
// SpeechRecognition is in lib.dom, but some TypeScript configs don't resolve
// it as a named global. Declaring the minimal surface we need avoids the issue
// without requiring tsconfig changes.

interface OraSpeechAlternative {
  transcript: string;
}
interface OraSpeechResult {
  isFinal: boolean;
  length: number;
  [i: number]: OraSpeechAlternative;
}
interface OraSpeechResultList {
  length: number;
  [i: number]: OraSpeechResult;
}
interface OraSpeechRecognitionEvent extends Event {
  results: OraSpeechResultList;
  resultIndex: number;
}
interface OraSpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface OraSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((ev: OraSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: OraSpeechRecognitionErrorEvent) => void) | null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceState =
  | "idle"
  | "listening"
  | "speaking"
  | "unsupported"
  | "permission_denied"
  | "error";

type SpeechRecognitionCtor = new () => OraSpeechRecognition;

// ─── Language mapping ─────────────────────────────────────────────────────────
// Ora language code → BCP-47 recognition/synthesis language tag.
// "auto" → empty string so the browser uses its default / ambient detection.
export const VOICE_LANG_MAP: Record<string, string> = {
  auto: "",
  en: "en-US",
  ar: "ar-SA",
  es: "es-ES",
  fr: "fr-FR",
};

export function cleanOraVoiceReplyForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "I included a code block in the written reply.")
    .replace(/\|([^|\n]+(?:\|[^|\n]+)+)\|/g, (_match, row: string) =>
      row
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join("; "),
    )
    .replace(/\$(\d+(?:[.,]\d+)?)/g, "$1 dollars")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/[_~#|$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The server TTS route (/api/public-ai/tts) rejects input over 4000 chars.
// Keep a safety margin and break on a word boundary so long replies still speak
// instead of silently failing the request.
const TTS_MAX_CHARS = 3900;

export function truncateForTts(text: string): string {
  if (text.length <= TTS_MAX_CHARS) return text;
  const slice = text.slice(0, TTS_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > TTS_MAX_CHARS * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
}

// ─── Female voice preference ──────────────────────────────────────────────────
// Ordered by quality — known high-quality female voice names across platforms.
const FEMALE_VOICE_HINTS = [
  // macOS / iOS enhanced (highest quality)
  "ava",
  "samantha",
  "victoria",
  "karen",
  "moira",
  "fiona",
  "tessa",
  "veena",
  // Windows / Edge natural voices
  "jenny",
  "aria",
  "zira",
  "hazel",
  // Google voices (Chrome)
  "google us english",
  "google uk english female",
  // Generic female indicators
  "female",
  "woman",
  // Additional common names across TTS engines
  "joanna",
  "kendra",
  "kimberly",
  "salli",
  "ivy",
  "natasha",
  "nicole",
  "lisa",
];

function isEnhancedVoice(v: SpeechSynthesisVoice): boolean {
  const n = v.name.toLowerCase();
  return (
    n.includes("enhanced") ||
    n.includes("premium") ||
    n.includes("natural") ||
    n.includes("neural") ||
    n.includes("wavenet")
  );
}

function isFemaleVoice(v: SpeechSynthesisVoice): boolean {
  const n = v.name.toLowerCase();
  return FEMALE_VOICE_HINTS.some((hint) => n.includes(hint));
}

/**
 * Pick the best default female voice for the given BCP-47 language tag.
 * Ranking: enhanced+female > female > enhanced > first available.
 */
function pickDefaultVoice(
  voices: SpeechSynthesisVoice[],
  bcp47: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const langPrefix = bcp47.split("-")[0];
  const pool =
    bcp47 && voices.filter((v) => v.lang.startsWith(langPrefix)).length > 0
      ? voices.filter((v) => v.lang.startsWith(langPrefix))
      : voices;

  return (
    pool.find((v) => isEnhancedVoice(v) && isFemaleVoice(v)) ??
    pool.find((v) => isFemaleVoice(v)) ??
    pool.find((v) => isEnhancedVoice(v)) ??
    pool[0]
  );
}

// ─── Feature detection ────────────────────────────────────────────────────────

function getSpeechRecognitionClass(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w["SpeechRecognition"] as SpeechRecognitionCtor | undefined) ??
    (w["webkitSpeechRecognition"] as SpeechRecognitionCtor | undefined) ??
    null
  );
}

export function isSpeechRecognitionAvailable(): boolean {
  return getSpeechRecognitionClass() !== null;
}

export function isSpeechSynthesisAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// ─── Preferences (sessionStorage / localStorage) ──────────────────────────────

function readTtsEnabled(): boolean {
  try {
    return sessionStorage.getItem("ora_tts_enabled") === "true";
  } catch {
    return false;
  }
}

function writeTtsEnabled(value: boolean): void {
  try {
    sessionStorage.setItem("ora_tts_enabled", value ? "true" : "false");
  } catch {
    /* ignore */
  }
}

function readVoiceUri(): string {
  try {
    return localStorage.getItem("ora_voice_uri") ?? "";
  } catch {
    return "";
  }
}

function writeVoiceUri(uri: string): void {
  try {
    localStorage.setItem("ora_voice_uri", uri);
  } catch {
    /* ignore */
  }
}

// ─── Hook return type ─────────────────────────────────────────────────────────

export interface UseOraVoiceReturn {
  voiceState: VoiceState;
  interimTranscript: string;
  isSupported: boolean;
  isSpeechSynthesisSupported: boolean;
  /** True when the browser can decode and play server-side TTS audio (AudioContext API). */
  isServerTtsSupported: boolean;
  isTtsEnabled: boolean;
  toggleTts: () => void;
  /** All voices available on this device, loaded asynchronously. */
  availableVoices: SpeechSynthesisVoice[];
  /** URI of the currently selected voice (empty = auto). */
  selectedVoiceURI: string;
  /** Persist a new voice selection. */
  setVoiceURI: (uri: string) => void;
  startListening: (lang: string) => void;
  stopListening: () => void;
  /** Speak only when the user's TTS toggle is on (regular read-aloud button). */
  speakText: (text: string, lang: string) => void;
  /** Unlock browser audio playback inside the user's Talk to Ora start gesture. */
  prepareVoicePlayback: () => Promise<void>;
  /**
   * Speak unconditionally — ignores the isTtsEnabled preference flag.
   * Used by Voice Conversation Mode, which has its own mute control.
   */
  speakTextForce: (text: string, lang: string) => void;
  stopSpeaking: () => void;
  /**
   * True when the server TTS has failed at least once this voice session AND the
   * user has not yet dismissed the notice. Becomes false permanently for the session
   * once clearTtsFailed() is called; resets to false on stopSpeaking / session exit.
   */
  ttsUnavailable: boolean;
  /** Permanently dismiss the TTS notice for this voice session. */
  clearTtsFailed: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param onFinalTranscript Called with the confirmed transcript text when recognition ends.
 *   The consumer places the text into the input box for review — NOT auto-sent.
 */
export function useOraVoice(onFinalTranscript: (text: string) => void): UseOraVoiceReturn {
  const SpeechRecognitionClass = getSpeechRecognitionClass();
  const isSupported = SpeechRecognitionClass !== null;
  const isSpeechSynthesisSupported = isSpeechSynthesisAvailable();
  const isServerTtsSupported =
    typeof window !== "undefined" &&
    Boolean(
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext,
    );

  const [voiceState, setVoiceState] = useState<VoiceState>(isSupported ? "idle" : "unsupported");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isTtsEnabled, setIsTtsEnabledState] = useState<boolean>(readTtsEnabled);

  // ─── Voice selection ─────────────────────────────────────────────────────
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURIState] = useState<string>(readVoiceUri);

  // Load voices — they may arrive asynchronously (especially on Chrome)
  useEffect(() => {
    if (!isSpeechSynthesisSupported) return;

    const load = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      setAvailableVoices(voices);

      // If no user preference yet, pick the best female voice for English
      setSelectedVoiceURIState((prev) => {
        if (prev) {
          // Validate — if the stored URI no longer exists, reset it
          const still = voices.find((v) => v.voiceURI === prev);
          if (still) return prev;
        }
        const best = pickDefaultVoice(voices, "en-US");
        const uri = best?.voiceURI ?? "";
        writeVoiceUri(uri);
        return uri;
      });
    };

    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [isSpeechSynthesisSupported]);

  const setVoiceURI = useCallback((uri: string) => {
    setSelectedVoiceURIState(uri);
    writeVoiceUri(uri);
  }, []);

  const recognitionRef = useRef<OraSpeechRecognition | null>(null);
  const accumulatedRef = useRef("");
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  // Keep a ref so speakRaw always sees the latest URI without needing it in deps
  const selectedVoiceURIRef = useRef(selectedVoiceURI);
  selectedVoiceURIRef.current = selectedVoiceURI;
  const availableVoicesRef = useRef(availableVoices);
  availableVoicesRef.current = availableVoices;
  const serverAudioContextRef = useRef<AudioContext | null>(null);
  const serverAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const serverTtsAbortRef = useRef<AbortController | null>(null);
  const serverSpeakSeqRef = useRef(0);

  const getServerAudioContext = useCallback(async (): Promise<AudioContext | null> => {
    if (typeof window === "undefined") return null;
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
      null;
    if (!AudioContextCtor) return null;

    let ctx = serverAudioContextRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContextCtor();
      serverAudioContextRef.current = ctx;
    }
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    return ctx;
  }, []);

  const stopServerAudio = useCallback(() => {
    serverTtsAbortRef.current?.abort();
    serverTtsAbortRef.current = null;
    const source = serverAudioSourceRef.current;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      serverAudioSourceRef.current = null;
    }
  }, []);

  const prepareVoicePlayback = useCallback(async () => {
    const ctx = await getServerAudioContext();
    if (!ctx) return;
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start();
  }, [getServerAudioContext]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      stopServerAudio();
      const ctx = serverAudioContextRef.current;
      serverAudioContextRef.current = null;
      if (ctx && ctx.state !== "closed") {
        void ctx.close().catch(() => undefined);
      }
      if (isSpeechSynthesisAvailable()) {
        window.speechSynthesis.cancel();
      }
    };
  }, [stopServerAudio]);

  // Tracks whether TTS has failed at least once in the current voice session.
  // Set on first failure; only reset when the session ends (stopSpeaking / exit).
  // Never cleared by the user dismiss action so subsequent failures stay silent.
  const [ttsFailedOnce, setTtsFailedOnce] = useState(false);
  // Tracks whether the user has dismissed the TTS notice this session.
  // Once true, further failures no longer re-show the banner until session exit.
  const [ttsNoticeDismissed, setTtsNoticeDismissed] = useState(false);

  // Exposed as ttsUnavailable: true only on the first failure, hidden after dismiss.
  const ttsUnavailable = ttsFailedOnce && !ttsNoticeDismissed;

  const clearTtsFailed = useCallback(() => {
    setTtsNoticeDismissed(true);
  }, []);

  const stopSpeaking = useCallback(() => {
    stopServerAudio();
    if (isSpeechSynthesisAvailable()) {
      window.speechSynthesis.cancel();
    }
    setVoiceState((s) => (s === "speaking" ? "idle" : s));
    setTtsFailedOnce(false);
    setTtsNoticeDismissed(false);
  }, [stopServerAudio]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    accumulatedRef.current = "";
    setInterimTranscript("");
    setVoiceState("idle");
  }, []);

  const startListening = useCallback(
    (lang: string) => {
      if (!isSupported || !SpeechRecognitionClass) return;

      // Stop any TTS playback before listening
      stopServerAudio();
      if (isSpeechSynthesisAvailable()) {
        window.speechSynthesis.cancel();
      }

      // Abort any existing recognition
      recognitionRef.current?.abort();
      accumulatedRef.current = "";

      try {
        const recognition = new SpeechRecognitionClass();
        const bcp47 = VOICE_LANG_MAP[lang] ?? "";
        if (bcp47) recognition.lang = bcp47;
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
          setVoiceState("listening");
          setInterimTranscript("");
        };

        recognition.onresult = (event: OraSpeechRecognitionEvent) => {
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i];
            if (r.isFinal) {
              accumulatedRef.current += r[0].transcript;
            } else {
              interim += r[0].transcript;
            }
          }
          // Show either the live interim text or what we've accumulated
          setInterimTranscript(interim || accumulatedRef.current);
        };

        recognition.onend = () => {
          recognitionRef.current = null;
          const finalText = accumulatedRef.current.trim();
          accumulatedRef.current = "";
          setInterimTranscript("");
          setVoiceState("idle");
          if (finalText) {
            // Hand off to consumer for review — do NOT auto-send
            onFinalRef.current(finalText);
          }
        };

        recognition.onerror = (event: OraSpeechRecognitionErrorEvent) => {
          recognitionRef.current = null;
          accumulatedRef.current = "";
          setInterimTranscript("");
          const code = event.error;
          if (code === "not-allowed" || code === "service-not-allowed") {
            setVoiceState("permission_denied");
          } else if (code === "no-speech" || code === "aborted") {
            // Silent return — no message needed, user just didn't speak or cancelled
            setVoiceState("idle");
          } else {
            setVoiceState("error");
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch {
        setVoiceState("error");
      }
    },
    [isSupported, SpeechRecognitionClass, stopServerAudio],
  );

  /** Shared speak logic — force=true bypasses the isTtsEnabled preference flag. */
  const speakRaw = useCallback(
    (text: string, lang: string) => {
      if (!isSpeechSynthesisSupported || !text.trim()) return;

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);

      // Apply selected voice
      const uri = selectedVoiceURIRef.current;
      const voices = availableVoicesRef.current;
      const voice = uri ? (voices.find((v) => v.voiceURI === uri) ?? null) : null;
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        // No stored preference yet — pick the best female voice on the fly
        const bcp47 = VOICE_LANG_MAP[lang] ?? "en-US";
        const best = pickDefaultVoice(voices, bcp47);
        if (best) {
          utterance.voice = best;
          utterance.lang = best.lang;
        } else {
          const bcp47Lang = VOICE_LANG_MAP[lang] ?? "";
          if (bcp47Lang) utterance.lang = bcp47Lang;
        }
      }

      // Natural-sounding parameters — slightly slower than 1.0 feels more conversational
      utterance.rate = 0.92;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      utterance.onstart = () => setVoiceState("speaking");
      utterance.onend = () => setVoiceState((s) => (s === "speaking" ? "idle" : s));
      utterance.onerror = () => setVoiceState((s) => (s === "speaking" ? "idle" : s));

      setVoiceState("speaking");
      window.speechSynthesis.speak(utterance);
    },
    [isSpeechSynthesisSupported],
  );

  /** Speak only when the user's TTS toggle is on (regular read-aloud button). */
  const speakText = useCallback(
    (text: string, lang: string) => {
      if (!isTtsEnabled) return;
      speakRaw(text, lang);
    },
    [isTtsEnabled, speakRaw],
  );

  /**
   * Speak unconditionally — ignores the isTtsEnabled preference.
   * Used by Voice Conversation Mode, which has its own mute control. This path
   * uses server-generated audio so Talk to Ora does not sound like browser
   * speechSynthesis. If the server voice fails, do not fall back to robotic
   * browser speech; leave the text reply visible and let the listener resume.
   */
  const speakTextForce = useCallback(
    (text: string, lang: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const seq = serverSpeakSeqRef.current + 1;
      serverSpeakSeqRef.current = seq;
      stopServerAudio();
      if (isSpeechSynthesisAvailable()) {
        window.speechSynthesis.cancel();
      }
      setVoiceState("speaking");

      const abort = new AbortController();
      serverTtsAbortRef.current = abort;

      void (async () => {
        try {
          const cleaned = cleanOraVoiceReplyForSpeech(trimmed) || trimmed;
          const spokenText = truncateForTts(cleaned);
          const ttsBody = JSON.stringify({ text: spokenText, language: lang });
          const requestTts = () =>
            authFetch("/api/public-ai/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: abort.signal,
              body: ttsBody,
            });

          let resp = await requestTts();
          if (resp.status === 401 && !abort.signal.aborted) {
            await authFetch("/api/public-ai/session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: abort.signal,
              body: "{}",
            });
            resp = await requestTts();
          }
          if (!resp.ok) throw new Error(`TTS failed (${resp.status})`);
          const arr = await resp.arrayBuffer();
          if (serverSpeakSeqRef.current !== seq || abort.signal.aborted) return;

          const ctx = await getServerAudioContext();
          if (!ctx) throw new Error("Web Audio is unavailable");
          const audioBuffer = await ctx.decodeAudioData(arr.slice(0));
          if (serverSpeakSeqRef.current !== seq || abort.signal.aborted) return;

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          serverAudioSourceRef.current = source;
          source.onended = () => {
            if (serverSpeakSeqRef.current !== seq) return;
            stopServerAudio();
            setVoiceState((s) => (s === "speaking" ? "idle" : s));
          };
          source.start();
        } catch (_err) {
          if (abort.signal.aborted) return;
          stopServerAudio();
          setVoiceState((s) => (s === "speaking" ? "idle" : s));
          setTtsFailedOnce(true);
        } finally {
          if (serverTtsAbortRef.current === abort) {
            serverTtsAbortRef.current = null;
          }
        }
      })();
    },
    [getServerAudioContext, stopServerAudio],
  );

  const toggleTts = useCallback(() => {
    setIsTtsEnabledState((prev) => {
      const next = !prev;
      writeTtsEnabled(next);
      if (!next && isSpeechSynthesisAvailable()) {
        window.speechSynthesis.cancel();
        setVoiceState((s) => (s === "speaking" ? "idle" : s));
      }
      return next;
    });
  }, []);

  return {
    voiceState,
    interimTranscript,
    isSupported,
    isSpeechSynthesisSupported,
    isServerTtsSupported,
    isTtsEnabled,
    toggleTts,
    availableVoices,
    selectedVoiceURI,
    setVoiceURI,
    startListening,
    stopListening,
    speakText,
    prepareVoicePlayback,
    speakTextForce,
    stopSpeaking,
    ttsUnavailable,
    clearTtsFailed,
  };
}
