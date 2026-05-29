/**
 * Voice UI components for Ora.
 *
 * IMPORTANT: there are TWO distinct voice experiences:
 *
 *  A. OraDictationButton  — small mic in the composer input bar.
 *     Starts/stops the SpeechRecognition listener. Transcript lands in the
 *     textarea so the user can review and edit before pressing Send manually.
 *     No automatic sending. No automatic TTS.
 *
 *  B. OraVoiceModeButton + OraVoiceConvPanel — "Talk with Ora" button that
 *     lives in the panel/bubble header near the Dynamic Atom. Enters a full
 *     Voice Conversation Mode: transcript is auto-sent, Ora's reply is
 *     auto-spoken, then listening restarts automatically for a live
 *     back-and-forth conversation.
 *
 * These are kept in one file so the shared waveform animation and keyframes
 * are only defined once. No backend calls, no audio storage, no transcript
 * logging — all implemented via browser-native Web Speech APIs.
 */

import { useEffect } from "react";
import {
  MicOff,
  AlertCircle,
  CheckCircle2,
  Mic,
  Square,
  PhoneOff,
  Volume2,
  VolumeX,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/use-ora-voice";
import type { WhisperState } from "@/hooks/use-whisper-recorder";

// ─── CSS keyframes (injected once into <head>) ──────────────────────────────

const KEYFRAMES = `
@keyframes ora-wave {
  0%   { height: var(--h-min, 2px); }
  100% { height: var(--h-max, 10px); }
}
@keyframes ora-ping {
  0%   { transform: scale(1);   opacity: 0.6; }
  100% { transform: scale(2.0); opacity: 0; }
}
@keyframes ora-idle-glow {
  0%, 100% { box-shadow: 0 0 0 0   hsl(265 85% 65% / 0.3), 0 2px 8px hsl(265 85% 65% / 0.2); }
  50%       { box-shadow: 0 0 0 4px hsl(265 85% 65% / 0.1), 0 4px 12px hsl(265 85% 65% / 0.3); }
}
@keyframes ora-speaking-glow {
  0%, 100% { box-shadow: 0 0 4px 1px hsl(265 85% 65% / 0.4), 0 2px 8px hsl(265 85% 65% / 0.2); }
  50%       { box-shadow: 0 0 10px 4px hsl(265 85% 65% / 0.55), 0 4px 16px hsl(265 85% 65% / 0.35); }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes ora-wave          { 0%, 100% { height: 6px; } }
  @keyframes ora-ping          { 0%, 100% { opacity: 0; } }
  @keyframes ora-idle-glow     { 0%, 100% { box-shadow: 0 2px 8px hsl(265 85% 65% / 0.2); } }
  @keyframes ora-speaking-glow { 0%, 100% { box-shadow: 0 0 6px 2px hsl(265 85% 65% / 0.4); } }
}
`;

let keyframesInjected = false;
function injectKeyframes() {
  if (typeof document === "undefined" || keyframesInjected) return;
  if (document.getElementById("ora-voice-kf")) {
    keyframesInjected = true;
    return;
  }
  const el = document.createElement("style");
  el.id = "ora-voice-kf";
  el.textContent = KEYFRAMES;
  document.head.appendChild(el);
  keyframesInjected = true;
}

// ─── Shared waveform bars ────────────────────────────────────────────────────

const BAR_DEFS: Array<{ min: number; max: number; dur: number }> = [
  { min: 2, max: 5, dur: 0.65 },
  { min: 3, max: 9, dur: 0.55 },
  { min: 4, max: 11, dur: 0.7 },
  { min: 2, max: 7, dur: 0.6 },
  { min: 5, max: 10, dur: 0.5 },
  { min: 3, max: 6, dur: 0.72 },
  { min: 2, max: 8, dur: 0.58 },
];

interface WaveformBarsProps {
  animated?: boolean;
  colorClass?: string;
  scale?: number;
}

function WaveformBars({
  animated = false,
  colorClass = "bg-white/90",
  scale = 1,
}: WaveformBarsProps) {
  return (
    <div className="flex items-end gap-[2px]" aria-hidden>
      {BAR_DEFS.map((b, i) => {
        const hMin = Math.max(1, Math.round(b.min * scale));
        const hMax = Math.round(b.max * scale);
        return (
          <span
            key={i}
            className={cn("w-[2px] rounded-full", colorClass)}
            style={
              animated
                ? ({
                    height: `${hMin}px`,
                    animation: `ora-wave ${b.dur}s ease-in-out ${i * 65}ms infinite alternate`,
                    "--h-min": `${hMin}px`,
                    "--h-max": `${hMax}px`,
                  } as React.CSSProperties)
                : { height: `${Math.round((hMin + hMax) / 2)}px` }
            }
          />
        );
      })}
    </div>
  );
}

// ─── A. OraDictationButton ───────────────────────────────────────────────────
// Small mic button that lives in the composer input bar (beside attachment).
// Activates speech-to-text dictation ONLY. Transcript lands in the textarea
// for review; the user presses Send manually. No auto-send, no auto-TTS.

export interface OraDictationButtonProps {
  voiceState: VoiceState;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
  /** "md" for OraPanel (h-7 w-7 icon h-4 w-4), "sm" for OraBubble (h-6 w-6 icon h-3.5 w-3.5) */
  size?: "sm" | "md";
}

export function OraDictationButton({
  voiceState,
  isSupported,
  onStart,
  onStop,
  disabled = false,
  size = "md",
}: OraDictationButtonProps) {
  useEffect(injectKeyframes, []);

  const isListening = voiceState === "listening";
  const isUnsupported = !isSupported || voiceState === "unsupported";
  const isDenied = voiceState === "permission_denied";
  const isError = voiceState === "error";
  const isInert = isUnsupported || isDenied;

  const dim = size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const iconDim = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  const title = isUnsupported
    ? "Voice input is not supported in this browser"
    : isDenied
      ? "Microphone access was denied. Enable it in your browser settings."
      : isError
        ? "Voice recognition failed. Tap to retry."
        : isListening
          ? "Stop dictation"
          : "Dictate your message (transcript lands in the text box for review)";

  const handleClick = () => {
    if (isInert || disabled) return;
    if (isListening) onStop();
    else onStart();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || isInert}
      title={title}
      aria-label={title}
      aria-pressed={isListening}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-lg transition-colors",
        dim,
        isListening
          ? "text-red-400 hover:text-red-300"
          : isInert
            ? "text-muted-foreground/25 cursor-not-allowed"
            : isError
              ? "text-amber-500 hover:text-amber-400"
              : "text-muted-foreground hover:text-foreground",
        disabled && !isInert && "opacity-40 cursor-not-allowed",
      )}
    >
      {isListening && (
        <span
          className="absolute inset-[-3px] rounded-full bg-red-400/20"
          style={{ animation: "ora-ping 1.3s ease-out infinite" }}
          aria-hidden
        />
      )}
      {isInert ? (
        <MicOff className={iconDim} />
      ) : isError ? (
        <AlertCircle className={iconDim} />
      ) : isListening ? (
        <Square className={iconDim} fill="currentColor" />
      ) : (
        <Mic className={iconDim} />
      )}
    </button>
  );
}

// ─── B. OraVoiceModeButton ───────────────────────────────────────────────────
// Premium circular orb shown in the panel/bubble header. Enters/exits the full
// Voice Conversation Mode (auto-send + auto-TTS + conversation cycling).
// The parent is responsible for the mode state and passing the correct
// voiceState (pass "idle" when conv mode is inactive so the button shows
// as ready-to-enter rather than reflecting dictation state).

export interface OraVoiceModeButtonProps {
  voiceState: VoiceState;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
  /** "md" for OraPanel (h-7 w-7), "sm" for OraBubble (h-6 w-6) */
  size?: "sm" | "md";
}

export function OraVoiceModeButton({
  voiceState,
  isSupported,
  onStart,
  onStop,
  disabled = false,
  size = "md",
}: OraVoiceModeButtonProps) {
  useEffect(injectKeyframes, []);

  const isListening = voiceState === "listening";
  const isSpeaking = voiceState === "speaking";
  const isUnsupported = !isSupported || voiceState === "unsupported";
  const isDenied = voiceState === "permission_denied";
  const isError = voiceState === "error";
  const isInert = isUnsupported || isDenied;
  const isActive = isListening || isSpeaking;

  const dim = size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const waveScale = size === "sm" ? 0.75 : 1;

  let ariaLabel = "Start voice conversation with Ora";
  if (isListening) ariaLabel = "Ora is listening — tap to end voice mode";
  if (isSpeaking) ariaLabel = "Ora is speaking — tap to end voice mode";
  if (isUnsupported) ariaLabel = "Voice input is not supported in this browser";
  if (isDenied) ariaLabel = "Microphone permission denied — enable in browser settings";
  if (isError) ariaLabel = "Voice failed — tap to try again";

  let title = "Talk with Ora — voice conversation mode";
  if (isListening) title = "Ora is listening — tap to end voice mode";
  if (isSpeaking) title = "Ora is speaking — tap to end voice mode";
  if (isUnsupported) title = "Voice is not supported in this browser. You can still type.";
  if (isDenied) title = "Microphone access was denied. Enable it in your browser settings.";
  if (isError) title = "Voice failed. Tap to try again.";

  const handleClick = () => {
    if (isInert || disabled) return;
    if (isActive) onStop();
    else onStart();
  };

  const buttonStyle: React.CSSProperties = isSpeaking
    ? { animation: "ora-speaking-glow 1.6s ease-in-out infinite" }
    : !isInert && !isActive && !isError
      ? { animation: "ora-idle-glow 3.5s ease-in-out 1.5s infinite" }
      : {};

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      disabled={disabled || isInert}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={isActive}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        dim,
        !isInert && !isError && "bg-gradient-to-br from-[hsl(265_85%_62%)] to-[hsl(220_80%_58%)]",
        !isActive &&
          !isInert &&
          !isError &&
          "hover:scale-110 hover:from-[hsl(265_85%_58%)] hover:to-[hsl(220_80%_54%)] focus-visible:ring-[hsl(265_85%_65%)]",
        isListening &&
          "ring-2 ring-red-400/70 shadow-md shadow-red-400/20 focus-visible:ring-red-400 hover:scale-100",
        isSpeaking && "focus-visible:ring-[hsl(265_85%_65%)]",
        isInert && "bg-muted opacity-35 cursor-not-allowed shadow-none",
        isError && "bg-amber-500/15 text-amber-500 focus-visible:ring-amber-400",
        disabled && !isInert && "opacity-40 cursor-not-allowed",
      )}
      style={buttonStyle}
    >
      {isListening && (
        <span
          className="absolute inset-[-4px] rounded-full bg-red-400/25"
          style={{ animation: "ora-ping 1.3s ease-out infinite" }}
          aria-hidden
        />
      )}
      {isInert ? (
        <MicOff
          className={cn("text-muted-foreground", size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")}
        />
      ) : isError ? (
        <AlertCircle className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
      ) : (
        <WaveformBars
          animated={isListening || isSpeaking}
          colorClass="bg-white/90"
          scale={waveScale}
        />
      )}
    </button>
  );
}

// ─── B. OraVoiceConvPanel ────────────────────────────────────────────────────
// Shown in the composer area in place of the normal text input while Voice
// Conversation Mode is active. Displays live state (listening / thinking /
// speaking), interim transcript, mute toggle, and an "End Voice Mode" button.

export interface OraVoiceConvPanelProps {
  voiceState: VoiceState;
  interimTranscript: string;
  isLoading: boolean;
  isTtsMuted: boolean;
  onToggleTtsMute: () => void;
  onExit: () => void;
  onInterrupt?: () => void;
  size?: "sm" | "md";
  /** Whisper push-to-talk state — when provided, replaces auto-listen with a hold-to-speak button */
  whisperState?: WhisperState;
  whisperSupported?: boolean;
  whisperError?: string | null;
  onWhisperStart?: () => Promise<void>;
  onWhisperStop?: () => void;
  onWhisperCancel?: () => void;
}

export function OraVoiceConvPanel({
  voiceState,
  interimTranscript,
  isLoading,
  isTtsMuted,
  onToggleTtsMute,
  onExit,
  onInterrupt,
  size = "md",
  whisperState,
  whisperSupported,
  whisperError,
  onWhisperStart,
  onWhisperStop,
}: OraVoiceConvPanelProps) {
  useEffect(injectKeyframes, []);

  const isListening = voiceState === "listening";
  const isSpeaking = voiceState === "speaking";
  const useWhisper = whisperSupported && whisperState !== undefined;
  const whisperRecording = whisperState === "recording";
  const whisperTranscribing = whisperState === "transcribing";
  const whisperIdle = !whisperState || whisperState === "idle" || whisperState === "error";

  const labelCls = size === "sm" ? "text-[10px]" : "text-[11px]";
  const headingCls = size === "sm" ? "text-xs" : "text-sm";

  const stateLabel = isLoading
    ? "Ora is thinking…"
    : isSpeaking
      ? "Ora is speaking…"
      : useWhisper
        ? whisperRecording
          ? "Recording…"
          : whisperTranscribing
            ? "Transcribing…"
            : "Voice Mode Active"
        : isListening
          ? "Listening…"
          : "Voice Mode Active";

  const subLabel = isLoading
    ? "Preparing reply…"
    : isSpeaking
      ? "Tap interrupt to speak"
      : useWhisper
        ? whisperRecording
          ? "Release to send — Whisper AI will transcribe your words"
          : whisperTranscribing
            ? "Processing your speech…"
            : whisperError
              ? whisperError
              : "Hold the button below and speak — release to send"
        : isListening
          ? interimTranscript
            ? `"${interimTranscript}"`
            : "Speak naturally — your words will auto-send"
          : "Starting…";

  return (
    <div className="rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.06)] px-4 py-3 flex flex-col gap-3">
      {/* State row */}
      <div className="flex items-center gap-3">
        <WaveformBars
          animated={isListening || isSpeaking || whisperRecording}
          colorClass={whisperRecording || isListening ? "bg-red-400" : "bg-[hsl(265_85%_65%)]"}
          scale={size === "sm" ? 0.85 : 1.1}
        />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className={cn("font-semibold text-foreground", headingCls)}>{stateLabel}</span>
          <span
            dir="auto"
            className={cn(
              "text-muted-foreground/60 leading-snug truncate",
              labelCls,
              isListening && interimTranscript && "italic",
              whisperError && "text-amber-500/80",
            )}
          >
            {subLabel}
          </span>
        </div>
        {/* Live indicator */}
        {(isListening || whisperRecording) && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-red-400 motion-safe:animate-pulse"
            aria-label="Recording"
          />
        )}
        {whisperTranscribing && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 text-[hsl(265_85%_65%)] animate-spin" />
        )}
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2">
        {/* Mute / unmute Ora's spoken replies */}
        <button
          type="button"
          onClick={onToggleTtsMute}
          title={isTtsMuted ? "Unmute Ora's voice replies" : "Mute Ora's voice replies"}
          aria-label={isTtsMuted ? "Unmute voice replies" : "Mute voice replies"}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
            isTtsMuted
              ? "border-border/40 text-muted-foreground/50 hover:text-muted-foreground"
              : "border-[hsl(265_85%_65%/0.35)] text-[hsl(265_85%_65%)] hover:border-[hsl(265_85%_65%/0.55)]",
          )}
        >
          {isTtsMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          {isTtsMuted ? "Muted" : "Voice on"}
        </button>

        {/* Whisper push-to-talk button */}
        {useWhisper && !isSpeaking && !isLoading && (
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              void onWhisperStart?.();
            }}
            onPointerUp={onWhisperStop}
            onPointerLeave={onWhisperStop}
            disabled={whisperTranscribing}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition-colors select-none touch-none",
              whisperRecording
                ? "border-red-400/60 bg-red-400/10 text-red-400"
                : whisperTranscribing
                  ? "border-border/40 text-muted-foreground/50 cursor-wait"
                  : "border-[hsl(265_85%_65%/0.45)] bg-[hsl(265_85%_65%/0.08)] text-[hsl(265_85%_65%)] hover:border-[hsl(265_85%_65%/0.7)] hover:bg-[hsl(265_85%_65%/0.14)] active:scale-95",
            )}
          >
            {whisperTranscribing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Mic className={cn("h-3 w-3", whisperRecording && "animate-pulse")} />
            )}
            {whisperRecording
              ? "Recording…"
              : whisperTranscribing
                ? "Transcribing…"
                : "Hold to speak"}
          </button>
        )}

        {/* Interrupt button (visible while Ora is speaking, whisper or not) */}
        {isSpeaking && onInterrupt && (
          <button
            type="button"
            onClick={onInterrupt}
            className="flex items-center gap-1.5 rounded-lg border border-border/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Mic className="h-3 w-3" />
            Interrupt
          </button>
        )}

        {/* Whisper idle hint — only show for non-whisper mode */}
        {!useWhisper && whisperIdle && !isSpeaking && !isLoading && (
          <span className={cn("text-muted-foreground/50", labelCls)}>
            {interimTranscript ? `"${interimTranscript}"` : null}
          </span>
        )}

        {/* End Voice Mode */}
        <button
          type="button"
          onClick={onExit}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1 text-xs text-destructive/70 hover:border-destructive/55 hover:bg-destructive/5 hover:text-destructive transition-colors"
        >
          <PhoneOff className="h-3 w-3" />
          End
        </button>
      </div>
    </div>
  );
}

// ─── OraVoiceLiveArea ────────────────────────────────────────────────────────
// Shown above the composer input bar during normal dictation mode only.
// Renders the listening panel, interim transcript, transcript-ready hint, and
// error states. Not shown during Voice Conversation Mode.

export interface OraVoiceLiveAreaProps {
  voiceState: VoiceState;
  interimTranscript: string;
  voiceReady?: boolean;
  voiceErrorMsg?: string | null;
  size?: "sm" | "md";
}

export function OraVoiceLiveArea({
  voiceState,
  interimTranscript,
  voiceReady = false,
  voiceErrorMsg,
  size = "md",
}: OraVoiceLiveAreaProps) {
  const isListening = voiceState === "listening";
  const isSpeaking = voiceState === "speaking";
  const showNothing = voiceState === "idle" && !voiceReady && !voiceErrorMsg && !interimTranscript;

  if (showNothing) return null;

  const label = size === "sm" ? "text-[10px]" : "text-[11px]";
  const heading = size === "sm" ? "text-[11px]" : "text-xs";

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {/* Listening panel */}
      {isListening && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-[hsl(265_85%_65%/0.22)] bg-[hsl(265_85%_65%/0.07)] px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <WaveformBars
              animated
              colorClass="bg-[hsl(265_85%_65%)]"
              scale={size === "sm" ? 0.8 : 1}
            />
            <span className={cn("font-medium text-[hsl(265_85%_65%)]", heading)}>
              Listening… speak now
            </span>
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-red-400 motion-safe:animate-pulse"
              aria-label="Recording"
            />
          </div>
          <p dir="auto" className={cn("leading-snug text-muted-foreground/60", label)}>
            {interimTranscript ? (
              <span className="italic">"{interimTranscript}"</span>
            ) : (
              "Your words will appear here. Press Send when done."
            )}
          </p>
        </div>
      )}

      {/* Speaking panel (TTS read-aloud via normal toggle) */}
      {isSpeaking && (
        <div className="flex items-center gap-2.5 rounded-xl border border-[hsl(265_85%_65%/0.22)] bg-[hsl(265_85%_65%/0.07)] px-3 py-2.5">
          <WaveformBars
            animated
            colorClass="bg-[hsl(265_85%_65%)]"
            scale={size === "sm" ? 0.8 : 1}
          />
          <span className={cn("font-medium text-[hsl(265_85%_65%)]", heading)}>
            Ora is speaking…
          </span>
          <span className={cn("ml-auto text-muted-foreground/50", label)}>Tap mic to stop</span>
        </div>
      )}

      {/* Transcript ready */}
      {voiceReady && voiceState === "idle" && !voiceErrorMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
          <span className={cn("text-emerald-600 dark:text-emerald-400", label)}>
            Transcript ready — review it, then press Send.
          </span>
        </div>
      )}

      {/* Error / permission denied */}
      {voiceErrorMsg && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className={cn("leading-snug text-amber-700 dark:text-amber-400", label)}>
            {voiceErrorMsg}
          </span>
        </div>
      )}
    </div>
  );
}
