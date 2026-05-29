/**
 * useWhisperRecorder
 *
 * Records audio via MediaRecorder and transcribes it using the server-side
 * Whisper endpoint (POST /api/public-ai/transcribe).
 *
 * Better than the browser's built-in SpeechRecognition for:
 *  - Noisy environments (push-to-talk captures only intentional speech)
 *  - Fast speakers and non-standard accents
 *  - Consistent cross-browser behaviour
 *
 * Usage:
 *   const w = useWhisperRecorder(onTranscript);
 *   // On pointerdown: w.startRecording()
 *   // On pointerup:   w.stopRecording()
 *   // On cancel:      w.cancelRecording()
 */

import { useState, useRef, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WhisperState = "idle" | "recording" | "transcribing" | "error";

export interface UseWhisperRecorderReturn {
  state: WhisperState;
  /** True when MediaRecorder + getUserMedia are available on this device. */
  isSupported: boolean;
  /** Start capturing audio from the microphone. */
  startRecording: () => Promise<void>;
  /** Stop capturing and send audio to Whisper for transcription. */
  stopRecording: () => void;
  /** Stop capturing and discard — no transcript produced. */
  cancelRecording: () => void;
  /** Non-null only in "error" state; resets after 3 s. */
  error: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBestMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWhisperRecorder(onTranscript: (text: string) => void): UseWhisperRecorderReturn {
  const isSupported =
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    "mediaDevices" in navigator &&
    "MediaRecorder" in window;

  const [state, setState] = useState<WhisperState>("idle");
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // ── Internal helpers ───────────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const handleError = useCallback(
    (msg: string) => {
      cleanup();
      setError(msg);
      setState("error");
      setTimeout(() => {
        setState("idle");
        setError(null);
      }, 3000);
    },
    [cleanup],
  );

  // ── Public API ─────────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (!isSupported) return;
    cancelledRef.current = false;
    setError(null);
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Hints to help the OS/browser reduce background noise.
          // Most browsers honour at least some of these.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        handleError("Microphone access denied. Please allow microphone access and try again.");
      } else if (name === "NotFoundError") {
        handleError("No microphone found on this device.");
      } else {
        handleError("Could not start recording. Please check your microphone.");
      }
      return;
    }

    if (cancelledRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;
    const mimeType = getBestMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      const wasCancelled = cancelledRef.current;
      const chunks = chunksRef.current.slice();
      cleanup();

      if (wasCancelled || chunks.length === 0) {
        setState("idle");
        return;
      }

      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (blob.size === 0) {
        setState("idle");
        return;
      }

      setState("transcribing");

      try {
        const resp = await fetch("/api/public-ai/transcribe?format=webm", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
          credentials: "include",
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const data = (await resp.json()) as { text?: string; error?: string };
        const text = data.text?.trim() ?? "";

        if (text) {
          onTranscriptRef.current(text);
        }
        setState("idle");
      } catch {
        handleError("Transcription failed. Please try again.");
      }
    };

    // Collect chunks every 200 ms so we always have data even for short clips.
    recorder.start(200);
    setState("recording");
  }, [isSupported, cleanup, handleError]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    } else {
      cleanup();
      setState("idle");
    }
  }, [cleanup]);

  return {
    state,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
    error,
  };
}
