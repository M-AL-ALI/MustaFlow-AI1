/**
 * OraVoiceTip — a subtle, dismissible first-run hint that surfaces Ora's voice
 * features (mic dictation, "Talk with Ora" voice mode, and spoken replies).
 *
 * Rules:
 *  - Shows only the first time a user opens Ora; dismissal is persisted in
 *    localStorage so it never returns once seen or dismissed.
 *  - Adapts its copy to what the current browser actually supports.
 *  - Never appears when both voice input and voice output are unsupported.
 *  - Notes that voice availability depends on the browser.
 */

import { useState, useEffect, useCallback } from "react";
import { Mic, X } from "lucide-react";
import { cn } from "@/lib/utils";

const VOICE_TIP_STORAGE_KEY = "ora_voice_tip_seen";

function readVoiceTipSeen(): boolean {
  try {
    return localStorage.getItem(VOICE_TIP_STORAGE_KEY) === "true";
  } catch {
    // If storage is unavailable, fail safe and don't nag the user.
    return true;
  }
}

function writeVoiceTipSeen(): void {
  try {
    localStorage.setItem(VOICE_TIP_STORAGE_KEY, "true");
  } catch {
    /* ignore */
  }
}

function buildTipText(inputSupported: boolean, outputSupported: boolean): string {
  if (inputSupported && outputSupported) {
    return "Ora can listen and talk. Tap the mic to dictate, or start \u201CTalk with Ora\u201D from the header for a spoken conversation. Voice features depend on your browser.";
  }
  if (inputSupported) {
    return "You can talk to Ora. Tap the mic to dictate instead of typing. Voice input depends on your browser.";
  }
  return "Ora can read replies aloud. Turn on voice responses from the options menu. Spoken replies depend on your browser.";
}

export function OraVoiceTip({
  voiceInputSupported,
  voiceOutputSupported,
  className,
}: {
  voiceInputSupported: boolean;
  voiceOutputSupported: boolean;
  className?: string;
}) {
  // Default to hidden; reveal only after confirming it has not been seen so the
  // tip never flashes for returning users.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!readVoiceTipSeen()) setVisible(true);
  }, []);

  const dismiss = useCallback(() => {
    writeVoiceTipSeen();
    setVisible(false);
  }, []);

  if (!visible) return null;
  // Never surface the tip on browsers with no voice support at all.
  if (!voiceInputSupported && !voiceOutputSupported) return null;

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-[hsl(var(--ora-accent-hsl,265_85%_65%)/0.35)] bg-[hsl(var(--ora-accent-hsl,265_85%_65%)/0.07)] px-3 py-2 mb-2 text-xs",
        className,
      )}
      role="status"
    >
      <Mic className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[hsl(var(--ora-accent-hsl,265_85%_65%))]" />
      <p className="flex-1 leading-snug text-foreground/90">
        {buildTipText(voiceInputSupported, voiceOutputSupported)}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss voice tip"
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
