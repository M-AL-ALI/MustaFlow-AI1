import { Mic, MicOff, Square, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/use-ora-voice";

interface OraVoiceMicButtonProps {
  voiceState: VoiceState;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
}

export function OraVoiceMicButton({
  voiceState,
  isSupported,
  onStart,
  onStop,
  disabled = false,
  size = "md",
}: OraVoiceMicButtonProps) {
  const iconCls = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const btnCls = size === "sm" ? "h-6 w-6" : "h-7 w-7";

  const isListening = voiceState === "listening";
  const isSpeaking = voiceState === "speaking";
  const isUnsupported = voiceState === "unsupported" || !isSupported;
  const isDenied = voiceState === "permission_denied";
  const isError = voiceState === "error";

  let title = "Start voice input";
  if (isUnsupported)
    title = "Voice input is not supported in this browser. You can still type your message.";
  if (isDenied)
    title = "Microphone access was denied. Enable it in your browser settings to use voice input.";
  if (isListening) title = "Stop listening";
  if (isSpeaking) title = "Ora is speaking — tap to stop";
  if (isError) title = "Voice recognition failed. Please try again or type your message.";

  const isInert = isUnsupported || isDenied;
  const isActive = isListening || isSpeaking;

  const handleClick = () => {
    if (isInert || disabled) return;
    if (isActive) {
      onStop();
    } else {
      onStart();
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || isInert}
      title={title}
      aria-label={title}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg transition-all duration-150",
        btnCls,
        !isActive && !isInert && !isError && "text-muted-foreground hover:text-foreground",
        isListening && "text-red-500 ring-2 ring-red-500/25",
        isSpeaking && "text-[hsl(265_85%_65%)]",
        isInert && "opacity-30 cursor-not-allowed",
        isError && "text-amber-500",
        disabled && !isInert && "opacity-40 cursor-not-allowed",
      )}
    >
      {isListening ? (
        <Square className={cn(iconCls, "fill-current")} />
      ) : isSpeaking ? (
        <Volume2 className={iconCls} />
      ) : isInert ? (
        <MicOff className={iconCls} />
      ) : (
        <Mic className={iconCls} />
      )}
    </button>
  );
}
