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

  const isSupported = typeof window !== "undefined" && getSpeechRecognitionCtor() !== null;

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) {
      stop();
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang ?? getVoiceLang();

    let finalBuffer = "";

    recognition.onstart = () => {
      setIsRecording(true);
      finalBuffer = "";
    };

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
        finalBuffer += newFinal;
      }
      onTranscript(finalBuffer + interimTranscript);
    };

    recognition.onerror = () => {
      stop();
    };

    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [stop, onTranscript, lang]);

  return { isRecording, isSupported, toggle };
}
