/**
 * Voice-A: browser-native SpeechRecognition + speechSynthesis.
 *
 * Design rules:
 * - Review-before-send: final transcript lands in the caller's input box; caller decides when to send.
 * - TTS defaults OFF; stored in sessionStorage under "ora_tts_enabled".
 * - No audio is stored permanently. No transcript text is logged anywhere.
 * - No backend routes needed for Voice-A.
 */

import { useState, useRef, useEffect, useCallback } from "react";

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

// ─── TTS preference (sessionStorage, default OFF) ─────────────────────────────

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

// ─── Hook return type ─────────────────────────────────────────────────────────

export interface UseOraVoiceReturn {
  voiceState: VoiceState;
  interimTranscript: string;
  isSupported: boolean;
  isSpeechSynthesisSupported: boolean;
  isTtsEnabled: boolean;
  toggleTts: () => void;
  startListening: (lang: string) => void;
  stopListening: () => void;
  speakText: (text: string, lang: string) => void;
  stopSpeaking: () => void;
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

  const [voiceState, setVoiceState] = useState<VoiceState>(isSupported ? "idle" : "unsupported");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isTtsEnabled, setIsTtsEnabledState] = useState<boolean>(readTtsEnabled);

  const recognitionRef = useRef<OraSpeechRecognition | null>(null);
  const accumulatedRef = useRef("");
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (isSpeechSynthesisAvailable()) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const stopSpeaking = useCallback(() => {
    if (isSpeechSynthesisAvailable()) {
      window.speechSynthesis.cancel();
    }
    setVoiceState((s) => (s === "speaking" ? "idle" : s));
  }, []);

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
    [isSupported, SpeechRecognitionClass],
  );

  const speakText = useCallback(
    (text: string, lang: string) => {
      if (!isSpeechSynthesisSupported || !isTtsEnabled || !text.trim()) return;

      // Cancel any ongoing utterance first
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      const bcp47 = VOICE_LANG_MAP[lang] ?? "";
      if (bcp47) utterance.lang = bcp47;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      utterance.onstart = () => setVoiceState("speaking");
      utterance.onend = () => setVoiceState((s) => (s === "speaking" ? "idle" : s));
      utterance.onerror = () => setVoiceState((s) => (s === "speaking" ? "idle" : s));

      setVoiceState("speaking");
      window.speechSynthesis.speak(utterance);
    },
    [isSpeechSynthesisSupported, isTtsEnabled],
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
    isTtsEnabled,
    toggleTts,
    startListening,
    stopListening,
    speakText,
    stopSpeaking,
  };
}
