import { useRef, useState, useCallback, useEffect } from "react";

type SpeechRecognitionResultEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const VOICE_LANG_KEY = "mustaflow_voice_lang";

export function getVoiceLang(): string {
  if (typeof window === "undefined") return "en-US";
  return localStorage.getItem(VOICE_LANG_KEY) ?? navigator.language ?? "en-US";
}

export function setVoiceLang(lang: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(VOICE_LANG_KEY, lang);
}

export function useVoiceInput(onTranscript: (text: string) => void, lang?: string) {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Whether we *intend* to be listening — survives browser-side session drops.
  const shouldListenRef = useRef(false);
  // Accumulated finals across auto-restarts so the transcript never resets.
  const finalBufferRef = useRef("");
  // Always-fresh callback ref so the inner recognition closure never goes stale.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Holds the restart function so onend can call it without circular useCallback deps.
  const restartRef = useRef<() => void>(() => {});

  const isSupported = typeof window !== "undefined" && getSpeechRecognitionCtor() !== null;

  // Creates and starts a fresh recognition instance. Called on first start and
  // on every auto-restart after the browser ends a continuous session.
  const startInstance = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor || !shouldListenRef.current) {
      shouldListenRef.current = false;
      setIsRecording(false);
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang ?? getVoiceLang();
    recognition.onstart = null;

    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      let interimTranscript = "";
      let newFinal = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          newFinal += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }
      if (newFinal) {
        finalBufferRef.current += newFinal;
      }
      onTranscriptRef.current(finalBufferRef.current + interimTranscript);
    };

    // onerror is always followed by onend — let onend decide whether to restart.
    recognition.onerror = () => {};

    recognition.onend = () => {
      recognitionRef.current = null;
      if (!shouldListenRef.current) {
        // Intentional stop — update UI.
        setIsRecording(false);
        return;
      }
      // Browser dropped the continuous session (common after silence on Chrome/Edge).
      // Restart seamlessly so the user never has to click again.
      restartRef.current();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      shouldListenRef.current = false;
      setIsRecording(false);
    }
  }, [lang]); // lang is the only reactive dep; all else uses refs

  // Keep restartRef in sync (updated every render so onend always calls the latest version)
  restartRef.current = startInstance;

  const stop = useCallback(() => {
    shouldListenRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }
    setIsRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      shouldListenRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const toggle = useCallback(() => {
    if (shouldListenRef.current) {
      stop();
      return;
    }
    shouldListenRef.current = true;
    finalBufferRef.current = "";
    setIsRecording(true);
    startInstance();
  }, [stop, startInstance]);

  return { isRecording, isSupported, toggle };
}
