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
import { authFetch } from "@/lib/api-fetch";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WhisperState = "idle" | "recording" | "transcribing" | "error";

export interface WhisperStartOptions {
  /** Automatically stop after speech followed by silence. Used by Talk to Ora sessions. */
  autoStop?: boolean;
  /** Silence duration after speech before the clip is finalized. */
  silenceMs?: number;
  /** How long to listen with no speech before restarting the listener. */
  noSpeechMs?: number;
  /** Hard cap for a single utterance. */
  maxMs?: number;
}

export interface UseWhisperRecorderReturn {
  state: WhisperState;
  /** True when MediaRecorder + getUserMedia are available on this device. */
  isSupported: boolean;
  /** Start capturing audio from the microphone. */
  startRecording: (options?: WhisperStartOptions) => Promise<void>;
  /** Stop capturing and send audio to Whisper for transcription. */
  stopRecording: () => void;
  /** Stop capturing and discard — no transcript produced. */
  cancelRecording: () => void;
  /** Non-null only in "error" state; resets after 3 s (except permission denial). */
  error: string | null;
  /**
   * True when the current error is a microphone permission denial
   * (NotAllowedError / PermissionDeniedError). The 3-second auto-reset is
   * suppressed — the error persists until the user explicitly retries or ends
   * the session, avoiding an infinite retry loop.
   */
  isPermissionDenied: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBestMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/** Derives the file-extension format string to pass to the server transcribe endpoint. */
function mimeTypeToFormat(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base === "audio/mp4" || base === "audio/m4a" || base === "video/mp4") return "mp4";
  if (base === "audio/ogg" || base === "video/ogg") return "ogg";
  if (base === "audio/wav" || base === "audio/wave") return "wav";
  if (base === "audio/mpeg" || base === "audio/mp3") return "mp3";
  return "webm";
}

const MIN_AUDIO_BYTES = 5_000;
const DEFAULT_SILENCE_MS = 1300;
const DEFAULT_NO_SPEECH_MS = 18_000;
const DEFAULT_MAX_UTTERANCE_MS = 30_000;
const SPEECH_RMS_THRESHOLD = 0.03;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param onTranscript  Called with the final transcript text after recording stops.
 * @param getLanguage   Optional — called at transcription time to get the current
 *                      ISO-639-1 language code (e.g. "ar", "en"). "auto" or undefined
 *                      lets Whisper detect the language automatically.
 */
export function useWhisperRecorder(
  onTranscript: (text: string) => void,
  getLanguage?: () => string,
): UseWhisperRecorderReturn {
  const isSupported =
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    "mediaDevices" in navigator &&
    "MediaRecorder" in window;

  const [state, setState] = useState<WhisperState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isPermissionDenied, setIsPermissionDenied] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Stable ref for getLanguage — always holds the latest caller value without
  // needing to add it to useCallback deps (same pattern as onTranscriptRef).
  const getLanguageRef = useRef(getLanguage);
  getLanguageRef.current = getLanguage;

  // ── Internal helpers ───────────────────────────────────────────────────────

  const stopAnalyser = useCallback(() => {
    if (analyserFrameRef.current !== null) {
      cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }
    const ctx = analyserContextRef.current;
    analyserContextRef.current = null;
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => undefined);
    }
  }, []);

  const cleanup = useCallback(() => {
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    stopAnalyser();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, [stopAnalyser]);

  const handleError = useCallback(
    (msg: string, permissionDenied = false) => {
      cleanup();
      setError(msg);
      setIsPermissionDenied(permissionDenied);
      setState("error");
      if (!permissionDenied) {
        setTimeout(() => {
          setState("idle");
          setError(null);
        }, 3000);
      }
    },
    [cleanup],
  );

  const startAutoStopMonitor = useCallback(
    (stream: MediaStream, recorder: MediaRecorder, options: WhisperStartOptions) => {
      stopAnalyser();

      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
        null;

      if (!AudioContextCtor) {
        window.setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, options.maxMs ?? DEFAULT_MAX_UTTERANCE_MS);
        return;
      }

      try {
        const ctx = new AudioContextCtor();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        analyserContextRef.current = ctx;

        const data = new Uint8Array(analyser.fftSize);
        const startedAt = performance.now();
        let heardSpeech = false;
        let silentSince = startedAt;

        const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
        const noSpeechMs = options.noSpeechMs ?? DEFAULT_NO_SPEECH_MS;
        const maxMs = options.maxMs ?? DEFAULT_MAX_UTTERANCE_MS;

        const tick = () => {
          if (recorder.state !== "recording") return;

          const now = performance.now();
          analyser.getByteTimeDomainData(data);
          let sumSq = 0;
          for (const sample of data) {
            const centered = (sample - 128) / 128;
            sumSq += centered * centered;
          }
          const rms = Math.sqrt(sumSq / data.length);
          const speaking = rms >= SPEECH_RMS_THRESHOLD;

          if (speaking) {
            heardSpeech = true;
            silentSince = now;
          }

          if (heardSpeech && now - silentSince >= silenceMs) {
            recorder.stop();
            return;
          }

          if (!heardSpeech && now - startedAt >= noSpeechMs) {
            cancelledRef.current = true;
            recorder.stop();
            return;
          }

          if (now - startedAt >= maxMs) {
            recorder.stop();
            return;
          }

          analyserFrameRef.current = requestAnimationFrame(tick);
        };

        analyserFrameRef.current = requestAnimationFrame(tick);
      } catch {
        window.setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, options.maxMs ?? DEFAULT_MAX_UTTERANCE_MS);
      }
    },
    [stopAnalyser],
  );

  // ── Public API ─────────────────────────────────────────────────────────────

  const startRecording = useCallback(
    async (options: WhisperStartOptions = {}) => {
      if (!isSupported) return;
      if (state === "recording" || state === "transcribing") return;
      cancelledRef.current = false;
      setError(null);
      setIsPermissionDenied(false);
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
          handleError(
            "Microphone access denied. Allow mic in your browser's address bar, then tap Retry.",
            true,
          );
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

        // Reject accidental taps — clips this small are always silent noise
        if (blob.size < MIN_AUDIO_BYTES) {
          setState("idle");
          return;
        }

        setState("transcribing");

        const audioFormat = mimeTypeToFormat(mimeType);

        try {
          const lang = getLanguageRef.current?.();
          const langParam = lang && lang !== "auto" ? `&lang=${encodeURIComponent(lang)}` : "";
          const abort = new AbortController();
          transcribeAbortRef.current = abort;
          const resp = await authFetch(
            `/api/public-ai/transcribe?format=${audioFormat}${langParam}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: blob,
              signal: abort.signal,
            },
          );

          if (!resp.ok) {
            let message = `Transcription failed (HTTP ${resp.status}).`;
            try {
              const errBody = (await resp.json()) as { error?: string };
              if (errBody.error) message = errBody.error;
            } catch {
              /* ignore JSON parse failure */
            }
            throw new Error(message);
          }

          const data = (await resp.json()) as { text?: string; error?: string };
          const text = data.text?.trim() ?? "";

          if (text) {
            onTranscriptRef.current(text);
          }
          setState("idle");
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          handleError(
            err instanceof Error ? err.message : "Transcription failed. Please try again.",
          );
        } finally {
          transcribeAbortRef.current = null;
        }
      };

      // Collect chunks every 200 ms so we always have data even for short clips.
      recorder.start(200);
      setState("recording");
      if (options.autoStop) {
        startAutoStopMonitor(stream, recorder, options);
      }
    },
    [isSupported, state, cleanup, handleError, startAutoStopMonitor],
  );

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
    isPermissionDenied,
  };
}
