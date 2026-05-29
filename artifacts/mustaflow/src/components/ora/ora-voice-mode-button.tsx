/**
 * OraVoiceModeButton — premium "Talk to Ora" button + live voice panel.
 *
 * Design rules:
 * - Original MustaFlow/Ora visual language — not a copy of any third-party UI.
 * - Gradient orb (purple → blue) with animated waveform bars.
 * - CSS-only animations (no external animation library).
 * - prefers-reduced-motion respected via @media in injected keyframes.
 * - Dark mode default; all colours use the project's HSL tokens.
 * - No backend calls, no transcript logging, no audio storage.
 *
 * Exports:
 *   OraVoiceModeButton  — drop-in for OraVoiceMicButton in the input bar
 *   OraVoiceLiveArea    — live voice panel rendered above the input bar
 */

import { useEffect } from "react";
import { MicOff, AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/use-ora-voice";

// ─── CSS keyframes (injected once into <head>) ─────────────────────────────

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
  @keyframes ora-wave        { 0%, 100% { height: 6px; } }
  @keyframes ora-ping        { 0%, 100% { opacity: 0; } }
  @keyframes ora-idle-glow   { 0%, 100% { box-shadow: 0 2px 8px hsl(265 85% 65% / 0.2); } }
  @keyframes ora-speaking-glow { 0%, 100% { box-shadow: 0 0 6px 2px hsl(265 85% 65% / 0.4); } }
}
`;

let keyframesInjected = false;
function injectKeyframes() {
  if (typeof document === "undefined" || keyframesInjected) return;
  if (document.getElementById("ora-voice-kf")) { keyframesInjected = true; return; }
  const el = document.createElement("style");
  el.id = "ora-voice-kf";
  el.textContent = KEYFRAMES;
  document.head.appendChild(el);
  keyframesInjected = true;
}

// ─── Waveform bars ─────────────────────────────────────────────────────────
// Seven bars with varied heights for a natural, asymmetric waveform shape.

const BAR_DEFS: Array<{ min: number; max: number; dur: number }> = [
  { min: 2, max: 5,  dur: 0.65 },
  { min: 3, max: 9,  dur: 0.55 },
  { min: 4, max: 11, dur: 0.70 },
  { min: 2, max: 7,  dur: 0.60 },
  { min: 5, max: 10, dur: 0.50 },
  { min: 3, max: 6,  dur: 0.72 },
  { min: 2, max: 8,  dur: 0.58 },
];

interface WaveformBarsProps {
  animated?: boolean;
  colorClass?: string;
  scale?: number;
}

function WaveformBars({ animated = false, colorClass = "bg-white/90", scale = 1 }: WaveformBarsProps) {
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
                ? {
                    height: `${hMin}px`,
                    animation: `ora-wave ${b.dur}s ease-in-out ${i * 65}ms infinite alternate`,
                    "--h-min": `${hMin}px`,
                    "--h-max": `${hMax}px`,
                  } as React.CSSProperties
                : { height: `${Math.round((hMin + hMax) / 2)}px` }
            }
          />
        );
      })}
    </div>
  );
}

// ─── OraVoiceModeButton ────────────────────────────────────────────────────

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

  const isListening    = voiceState === "listening";
  const isSpeaking     = voiceState === "speaking";
  const isUnsupported  = !isSupported || voiceState === "unsupported";
  const isDenied       = voiceState === "permission_denied";
  const isError        = voiceState === "error";
  const isInert        = isUnsupported || isDenied;
  const isActive       = isListening || isSpeaking;

  const dim       = size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const waveScale = size === "sm" ? 0.75 : 1;

  let ariaLabel = "Start talking to Ora";
  if (isListening)   ariaLabel = "Stop listening";
  if (isSpeaking)    ariaLabel = "Ora is speaking — tap to stop";
  if (isUnsupported) ariaLabel = "Voice input is not supported in this browser";
  if (isDenied)      ariaLabel = "Microphone permission denied — enable in browser settings";
  if (isError)       ariaLabel = "Voice recognition failed — tap to try again";

  let title = "Talk to Ora";
  if (isListening)   title = "Stop listening";
  if (isSpeaking)    title = "Ora is speaking — tap to stop";
  if (isUnsupported) title = "Voice is not supported in this browser. You can still type.";
  if (isDenied)      title = "Microphone access was denied. Enable it in your browser settings or type your message.";
  if (isError)       title = "Voice recognition failed. Please try again or type your message.";

  const handleClick = () => {
    if (isInert || disabled) return;
    if (isActive) onStop();
    else onStart();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  const buttonStyle: React.CSSProperties =
    isSpeaking
      ? { animation: "ora-speaking-glow 1.6s ease-in-out infinite" }
      : !isInert && !isActive && !isError
      ? { animation: "ora-idle-glow 3.5s ease-in-out 1.5s infinite" }
      : {};

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled || isInert}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={isActive}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        dim,
        // ── Gradient orb (default) ──────────────────────────────────────
        !isInert && !isError &&
          "bg-gradient-to-br from-[hsl(265_85%_62%)] to-[hsl(220_80%_58%)]",
        // ── Idle / hover ─────────────────────────────────────────────────
        !isActive && !isInert && !isError &&
          "hover:scale-110 hover:from-[hsl(265_85%_58%)] hover:to-[hsl(220_80%_54%)] focus-visible:ring-[hsl(265_85%_65%)]",
        // ── Listening: warm red ring + no hover scale ─────────────────────
        isListening &&
          "ring-2 ring-red-400/70 shadow-md shadow-red-400/20 focus-visible:ring-red-400 hover:scale-100",
        // ── Speaking ─────────────────────────────────────────────────────
        isSpeaking && "focus-visible:ring-[hsl(265_85%_65%)]",
        // ── Unsupported / denied ─────────────────────────────────────────
        isInert && "bg-muted opacity-35 cursor-not-allowed shadow-none",
        // ── Error ────────────────────────────────────────────────────────
        isError && "bg-amber-500/15 text-amber-500 focus-visible:ring-amber-400",
        // ── Loading / at-limit ────────────────────────────────────────────
        disabled && !isInert && "opacity-40 cursor-not-allowed",
      )}
      style={buttonStyle}
    >
      {/* Ping ring when listening */}
      {isListening && (
        <span
          className="absolute inset-[-4px] rounded-full bg-red-400/25"
          style={{ animation: "ora-ping 1.3s ease-out infinite" }}
          aria-hidden
        />
      )}

      {isInert ? (
        <MicOff
          className={cn(
            "text-muted-foreground",
            size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5",
          )}
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

// ─── OraVoiceLiveArea ──────────────────────────────────────────────────────
// Replaces the inline interim-transcript + error blocks above the input bar.

export interface OraVoiceLiveAreaProps {
  voiceState: VoiceState;
  interimTranscript: string;
  /** Set true immediately after voice transcript lands in the composer. */
  voiceReady?: boolean;
  /** Pre-computed error message string from the parent (null/undefined = none). */
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
  const isSpeaking  = voiceState === "speaking";
  const showNothing =
    voiceState === "idle" && !voiceReady && !voiceErrorMsg && !interimTranscript;

  if (showNothing) return null;

  const label   = size === "sm" ? "text-[10px]" : "text-[11px]";
  const heading = size === "sm" ? "text-[11px]" : "text-xs";

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {/* ── Listening panel ─────────────────────────────────────────────── */}
      {isListening && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-[hsl(265_85%_65%/0.22)] bg-[hsl(265_85%_65%/0.07)] px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <WaveformBars
              animated
              colorClass="bg-[hsl(265_85%_65%)]"
              scale={size === "sm" ? 0.8 : 1}
            />
            <span className={cn("font-medium text-[hsl(265_85%_65%)]", heading)}>
              Ora is listening…
            </span>
            {/* Live red indicator dot */}
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-red-400 motion-safe:animate-pulse"
              aria-label="Recording"
            />
          </div>
          <p className={cn("leading-snug text-muted-foreground/60", label)}>
            {interimTranscript ? (
              <span className="italic">"{interimTranscript}"</span>
            ) : (
              "Speak naturally. Your words will appear here before sending."
            )}
          </p>
        </div>
      )}

      {/* ── Speaking panel ───────────────────────────────────────────────── */}
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
          <span className={cn("ml-auto text-muted-foreground/50", label)}>
            Tap to stop
          </span>
        </div>
      )}

      {/* ── Transcript ready ─────────────────────────────────────────────── */}
      {voiceReady && voiceState === "idle" && !voiceErrorMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
          <span className={cn("text-emerald-600 dark:text-emerald-400", label)}>
            Review your transcript, then press Send.
          </span>
        </div>
      )}

      {/* ── Error / permission denied ────────────────────────────────────── */}
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
