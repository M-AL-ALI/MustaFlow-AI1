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
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/use-ora-voice";
import type { WhisperState } from "@/hooks/use-whisper-recorder";
import {
  LOW_TIME_WARNING_SECONDS,
  type RealtimeVoiceState,
  type RealtimeOverLimit,
} from "@/hooks/use-ora-realtime-voice";

/** Format a seconds countdown as m:ss for the realtime session timer. */
function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

/** Human-friendly "refreshes in ~Nh/Nm" hint for the per-plan live-voice budget. */
function formatResetHint(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  const diffMs = resetMs - Date.now();
  if (diffMs <= 0) return "Your voice time has refreshed — start a new session";
  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) {
    return `Refreshes in about ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(totalMinutes / 60);
  return `Refreshes in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Collapse the richer realtime state machine into the header orb's VoiceState.
 * The detailed live-conversation states are surfaced inside OraVoiceConvPanel;
 * the header button only needs an active/listening/speaking glow.
 */
export function mapRealtimeToVoiceState(state: RealtimeVoiceState): VoiceState {
  switch (state) {
    case "listening":
    case "connecting":
    case "thinking":
      return "listening";
    case "speaking":
      return "speaking";
    case "permission_denied":
      return "permission_denied";
    case "error":
      return "error";
    case "unsupported":
      return "unsupported";
    default:
      return "idle";
  }
}

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
  active?: boolean;
  disabled?: boolean;
  /** "md" for OraPanel (h-7 w-7), "sm" for OraBubble (h-6 w-6) */
  size?: "sm" | "md";
}

export function OraVoiceModeButton({
  voiceState,
  isSupported,
  onStart,
  onStop,
  active,
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
  const isActive = active ?? (isListening || isSpeaking);

  const dim = size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const waveScale = size === "sm" ? 0.75 : 1;

  let ariaLabel = "Start voice conversation with Ora";
  if (isActive && !isListening && !isSpeaking) ariaLabel = "Voice mode active - tap to end";
  if (isListening) ariaLabel = "Ora is listening — tap to end voice mode";
  if (isSpeaking) ariaLabel = "Ora is speaking — tap to end voice mode";
  if (isUnsupported) ariaLabel = "Voice input is not supported in this browser";
  if (isDenied) ariaLabel = "Microphone permission denied — enable in browser settings";
  if (isError) ariaLabel = "Voice failed — tap to try again";

  let title = "Talk with Ora — voice conversation mode";
  if (isActive && !isListening && !isSpeaking) title = "Voice mode active - tap to end";
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
        <WaveformBars animated={isActive} colorClass="bg-white/90" scale={waveScale} />
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
  /** Whisper session state for automatic Talk to Ora listening. */
  whisperState?: WhisperState;
  whisperSupported?: boolean;
  whisperError?: string | null;
  /** True when the whisper error is a mic permission denial (no auto-retry). */
  whisperPermissionDenied?: boolean;
  onWhisperStart?: () => Promise<void>;
  onWhisperStop?: () => void;
  onWhisperCancel?: () => void;
  /** Set to true after a TTS failure to show a one-time text-only notice. */
  ttsUnavailable?: boolean;
  onDismissTtsNotice?: () => void;
  // ─── Realtime ("Talk to Ora") transport ─────────────────────────────────────
  /**
   * Active voice transport. "realtime" renders the GA WebRTC live-conversation
   * view; "fallback" (default) renders the legacy whisper -> chat -> TTS loop.
   */
  transport?: "realtime" | "fallback";
  /** Realtime connection/turn state — only read when transport === "realtime". */
  realtimeState?: RealtimeVoiceState;
  /** Live partial transcript of what the user is currently saying (realtime). */
  interimUserText?: string;
  /** Live partial transcript of what Ora is currently saying (realtime). */
  interimAssistantText?: string;
  /** Seconds left before the tier duration cap force-ends the realtime call. */
  remainingSeconds?: number | null;
  /**
   * Set when the per-plan live-voice budget is exhausted (at start or mid-call).
   * Rendered as a graceful "out of voice time" message with the reset time in
   * the ended state — never a fallback (that would bypass the cap).
   */
  overLimit?: RealtimeOverLimit | null;
  /**
   * Visible warning shown when realtime could not start (or dropped) and the
   * legacy fallback loop took over. Rendered in the fallback view.
   */
  fallbackNotice?: string | null;
  onDismissFallbackNotice?: () => void;
  /**
   * When the realtime call has fallen back to the legacy loop, show a Retry
   * action in the fallback notice so the user can rebuild the live session.
   */
  showRetry?: boolean;
  onRetry?: () => void;
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
  whisperPermissionDenied = false,
  onWhisperStart,
  ttsUnavailable,
  onDismissTtsNotice,
  transport = "fallback",
  realtimeState = "idle",
  interimUserText = "",
  interimAssistantText = "",
  remainingSeconds = null,
  overLimit = null,
  fallbackNotice = null,
  onDismissFallbackNotice,
  showRetry = false,
  onRetry,
}: OraVoiceConvPanelProps) {
  useEffect(injectKeyframes, []);

  // ─── Realtime live-conversation view (GA WebRTC) ──────────────────────────
  if (transport === "realtime") {
    return (
      <OraRealtimeConvView
        state={realtimeState}
        interimUserText={interimUserText}
        interimAssistantText={interimAssistantText}
        remainingSeconds={remainingSeconds}
        overLimit={overLimit}
        isTtsMuted={isTtsMuted}
        onToggleTtsMute={onToggleTtsMute}
        onInterrupt={onInterrupt}
        onExit={onExit}
        size={size}
      />
    );
  }

  const isListening = voiceState === "listening";
  const isSpeaking = voiceState === "speaking";
  const useWhisper = whisperSupported && whisperState !== undefined;
  const whisperRecording = whisperState === "recording";
  const whisperTranscribing = whisperState === "transcribing";
  const whisperIdle = !whisperState || whisperState === "idle" || whisperState === "error";
  const isMicDenied = whisperPermissionDenied && !!whisperError;

  const labelCls = size === "sm" ? "text-[10px]" : "text-[11px]";
  const headingCls = size === "sm" ? "text-xs" : "text-sm";

  const stateLabel = isLoading
    ? "Ora is thinking…"
    : isSpeaking
      ? "Ora is speaking…"
      : isMicDenied
        ? "Microphone blocked"
        : useWhisper
          ? whisperRecording
            ? "Listening…"
            : whisperTranscribing
              ? "Transcribing…"
              : "Listening…"
          : isListening
            ? "Listening…"
            : "Voice Mode Active";

  const subLabel = isLoading
    ? "Preparing reply…"
    : isSpeaking
      ? "Tap interrupt to speak"
      : isMicDenied
        ? "Allow mic in your browser's address bar, then tap Retry"
        : useWhisper
          ? whisperRecording
            ? "Speak naturally — Ora will answer when you pause"
            : whisperTranscribing
              ? "Processing your speech…"
              : whisperError
                ? whisperError
                : "Speak naturally — Ora is ready"
          : isListening
            ? interimTranscript
              ? `"${interimTranscript}"`
              : "Speak naturally — your words will auto-send"
            : "Starting…";

  return (
    <div className="rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.06)] px-4 py-3 flex flex-col gap-3">
      {/* Realtime-unavailable warning — surfaces when the live WebRTC transport
          could not start (or dropped) and this legacy loop took over. */}
      {fallbackNotice && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="flex-1 leading-snug">{fallbackNotice}</span>
          {showRetry && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-md border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-600 hover:bg-amber-500/15 dark:text-amber-400 transition-colors"
            >
              Retry
            </button>
          )}
          {onDismissFallbackNotice && (
            <button
              type="button"
              onClick={onDismissFallbackNotice}
              aria-label="Dismiss"
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

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

      {/* TTS unavailable notice — shown below state row, above controls */}
      {ttsUnavailable && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <VolumeX className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Voice replies unavailable — Ora will reply in text only</span>
          <button
            type="button"
            onClick={onDismissTtsNotice}
            aria-label="Dismiss"
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
          {isTtsMuted ? "Unmute" : "Mute"}
        </button>

        {/* Whisper automatic listening status */}
        {useWhisper &&
          !isSpeaking &&
          !isLoading &&
          (isMicDenied ? (
            /* Mic permission denied — show alert + Retry instead of the active pill */
            <>
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/8 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400 select-none",
                )}
              >
                <AlertCircle className="h-3 w-3 shrink-0" />
                Mic blocked
              </span>
              {onWhisperStart && (
                <button
                  type="button"
                  onClick={() => void onWhisperStart()}
                  className="flex items-center gap-1.5 rounded-lg border border-[hsl(265_85%_65%/0.45)] bg-[hsl(265_85%_65%/0.08)] px-2.5 py-1 text-xs text-[hsl(265_85%_65%)] hover:border-[hsl(265_85%_65%/0.65)] hover:bg-[hsl(265_85%_65%/0.14)] transition-colors"
                >
                  <Mic className="h-3 w-3" />
                  Retry
                </button>
              )}
            </>
          ) : (
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition-colors select-none touch-none",
                whisperRecording
                  ? "border-red-400/60 bg-red-400/10 text-red-400"
                  : whisperTranscribing
                    ? "border-border/40 text-muted-foreground/50 cursor-wait"
                    : "border-[hsl(265_85%_65%/0.45)] bg-[hsl(265_85%_65%/0.08)] text-[hsl(265_85%_65%)]",
              )}
            >
              {whisperTranscribing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Mic className={cn("h-3 w-3", whisperRecording && "animate-pulse")} />
              )}
              {whisperRecording
                ? "Listening…"
                : whisperTranscribing
                  ? "Transcribing…"
                  : "Auto listening"}
            </span>
          ))}

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

// ─── OraRealtimeConvView ─────────────────────────────────────────────────────
// The live "Talk to Ora" conversation surface backed by the GA OpenAI Realtime
// API over WebRTC. Unlike the legacy fallback view, there is no manual record /
// transcribe step: the mic is always live, Ora answers as you pause, and you can
// barge in. This renders connection/turn state, live partial transcripts, the
// tier duration countdown, mute (Ora audio only), interrupt, and end controls.

interface OraRealtimeConvViewProps {
  state: RealtimeVoiceState;
  interimUserText: string;
  interimAssistantText: string;
  remainingSeconds: number | null;
  overLimit: RealtimeOverLimit | null;
  isTtsMuted: boolean;
  onToggleTtsMute: () => void;
  onInterrupt?: () => void;
  onExit: () => void;
  size: "sm" | "md";
}

function OraRealtimeConvView({
  state,
  interimUserText,
  interimAssistantText,
  remainingSeconds,
  overLimit,
  isTtsMuted,
  onToggleTtsMute,
  onInterrupt,
  onExit,
  size,
}: OraRealtimeConvViewProps) {
  const isConnecting = state === "connecting";
  const isListening = state === "listening";
  const isThinking = state === "thinking";
  const isSpeaking = state === "speaking";
  const isDenied = state === "permission_denied";
  const isError = state === "error";
  const isEnded = state === "ended";

  const labelCls = size === "sm" ? "text-[10px]" : "text-[11px]";
  const headingCls = size === "sm" ? "text-xs" : "text-sm";

  const stateLabel = isConnecting
    ? "Connecting…"
    : isThinking
      ? "Ora is thinking…"
      : isSpeaking
        ? "Ora is speaking…"
        : isDenied
          ? "Microphone blocked"
          : isError
            ? "Voice connection lost"
            : isEnded
              ? "Voice session ended"
              : isListening
                ? "Listening…"
                : "Starting…";

  // The detail line favors whichever live transcript is flowing, then falls back
  // to context-appropriate guidance.
  const detail = isConnecting
    ? "Setting up a live voice connection…"
    : isThinking
      ? "Preparing a spoken reply…"
      : isSpeaking
        ? interimAssistantText
          ? interimAssistantText
          : "Tap interrupt to jump in"
        : isDenied
          ? "Allow mic access in your browser, then end and start again"
          : isError
            ? "End and try again, or use the text composer"
            : isEnded
              ? overLimit
                ? ""
                : "Tap the orb to start a new voice session"
              : isListening
                ? interimUserText
                  ? `"${interimUserText}"`
                  : "Speak naturally — Ora listens as you talk"
                : "Getting ready…";

  const animated = isConnecting || isListening || isThinking || isSpeaking;
  const resetHint = formatResetHint(overLimit?.resetsAt);
  // "Running low" once the per-session countdown crosses the warning threshold.
  const lowTime =
    !overLimit &&
    remainingSeconds !== null &&
    remainingSeconds > 0 &&
    remainingSeconds <= LOW_TIME_WARNING_SECONDS;

  return (
    <div className="rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.06)] px-4 py-3 flex flex-col gap-3">
      {/* State row */}
      <div className="flex items-center gap-3">
        <WaveformBars
          animated={animated}
          colorClass={isListening ? "bg-red-400" : "bg-[hsl(265_85%_65%)]"}
          scale={size === "sm" ? 0.85 : 1.1}
        />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span
            className={cn("font-semibold text-foreground flex items-center gap-1.5", headingCls)}
          >
            <span className="rounded bg-[hsl(265_85%_65%/0.15)] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-[hsl(265_85%_65%)]">
              Live
            </span>
            {stateLabel}
          </span>
          <span
            dir="auto"
            className={cn(
              "text-muted-foreground/60 leading-snug truncate",
              labelCls,
              isListening && interimUserText && "italic",
              (isDenied || isError) && "text-amber-500/80",
            )}
          >
            {detail}
          </span>
        </div>
        {/* Live recording dot */}
        {isListening && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-red-400 motion-safe:animate-pulse"
            aria-label="Listening"
          />
        )}
        {(isConnecting || isThinking) && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 text-[hsl(265_85%_65%)] animate-spin" />
        )}
      </div>

      {/* Over-limit notice — per-plan live-voice budget is used up. Graceful, no
          fallback (that would bypass the cap); text Ora is still available. */}
      {overLimit && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className={cn("text-amber-600/90 dark:text-amber-400/90 leading-snug", labelCls)}>
            {overLimit.message}
          </p>
          {resetHint && (
            <p className={cn("mt-1 text-muted-foreground/70", labelCls)}>{resetHint}</p>
          )}
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center gap-2">
        {/* Mute / unmute Ora's spoken audio (mic stays live regardless) */}
        <button
          type="button"
          onClick={onToggleTtsMute}
          title={isTtsMuted ? "Unmute Ora's voice" : "Mute Ora's voice"}
          aria-label={isTtsMuted ? "Unmute Ora's voice" : "Mute Ora's voice"}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
            isTtsMuted
              ? "border-border/40 text-muted-foreground/50 hover:text-muted-foreground"
              : "border-[hsl(265_85%_65%/0.35)] text-[hsl(265_85%_65%)] hover:border-[hsl(265_85%_65%/0.55)]",
          )}
        >
          {isTtsMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          {isTtsMuted ? "Unmute" : "Mute"}
        </button>

        {/* Interrupt / barge-in (only while Ora is speaking) */}
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

        {/* Tier duration countdown — amber once the live-voice budget runs low */}
        {remainingSeconds !== null && !overLimit && (
          <span
            className={cn(
              "tabular-nums select-none",
              labelCls,
              lowTime ? "text-amber-500/90" : "text-muted-foreground/50",
            )}
            title={lowTime ? "Voice time running low" : "Time left in this voice session"}
          >
            {formatRemaining(remainingSeconds)}
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
  const showNothing =
    (voiceState === "idle" || voiceState === "unsupported") &&
    !voiceReady &&
    !voiceErrorMsg &&
    !interimTranscript;

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
