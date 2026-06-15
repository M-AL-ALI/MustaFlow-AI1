/**
 * Phase 4 — Voice-A validation suite.
 *
 * Voice-A keeps normal composer dictation browser-native while Talk to Ora
 * voice sessions use dedicated backend transcription/TTS routes. These tests verify:
 *
 *  1. Security: voice hook has no database, secrets, or server imports
 *  2. Privacy: no transcript logging or audio storage in hook code
 *  3. Language mapping: BCP-47 tags are correct for all supported locales
 *  4. TTS default: preference stored as "false" unless user enables it
 *  5. State machine: error classification is correct (permission_denied vs error vs idle)
 *  6. Review-before-send: hook calls onFinalTranscript, NOT sendMessage directly
 *  7. Regression: normal chat stays text-only and voice-session routes stay isolated
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const FE_SRC = join(REPO_ROOT, "artifacts", "mustaflow", "src");
const API_ROUTES = join(REPO_ROOT, "artifacts", "api-server", "src", "routes", "public-ai");

function readHook(relPath: string): string {
  return readFileSync(join(FE_SRC, relPath), "utf-8");
}

function readApiRoute(filename: string): string {
  return readFileSync(join(API_ROUTES, filename), "utf-8");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 4 — Voice-A: use-ora-voice hook", () => {
  const hookSrc = readHook("hooks/use-ora-voice.ts");

  it("exports useOraVoice and VOICE_LANG_MAP", () => {
    expect(hookSrc).toContain("export function useOraVoice");
    expect(hookSrc).toContain("export const VOICE_LANG_MAP");
  });

  it("has no DB or server imports (pure frontend module)", () => {
    const forbidden = ["drizzle", "pg", "postgres", "db/schema", "from '@/lib/db'", "from '../db'"];
    for (const token of forbidden) {
      expect(hookSrc, `hook must not import "${token}"`).not.toContain(token);
    }
  });

  it("has no secret or credential references", () => {
    const forbidden = ["process.env", "OPENAI", "ANTHROPIC", "SECRET"];
    for (const token of forbidden) {
      expect(hookSrc, `hook must not reference "${token}"`).not.toContain(token);
    }
  });

  it("does NOT call console.log or any logging (privacy)", () => {
    expect(hookSrc).not.toContain("console.log");
    expect(hookSrc).not.toContain("console.error");
    expect(hookSrc).not.toContain("logger.");
    expect(hookSrc).not.toContain("req.log");
  });

  it("does NOT store audio (privacy)", () => {
    const audioStoragePatterns = ["Blob", "MediaRecorder"];
    for (const p of audioStoragePatterns) {
      expect(hookSrc, `hook must not use "${p}"`).not.toContain(p);
    }
  });

  it("does NOT auto-send — calls onFinalTranscript callback, not sendMessage", () => {
    expect(hookSrc).toContain("onFinalTranscript");
    expect(hookSrc).toContain("onFinalRef.current(finalText)");
    expect(hookSrc).not.toContain("sendMessage(");
  });

  it("TTS defaults to OFF (reads 'true' as the only opt-in value)", () => {
    expect(hookSrc).toContain(`=== "true"`);
    expect(hookSrc).not.toContain(`=== "false"`);
  });

  it("sessionStorage key for TTS is ora_tts_enabled", () => {
    expect(hookSrc).toContain('"ora_tts_enabled"');
  });

  it("cancels TTS before startListening (interruption rule)", () => {
    const startListeningIdx = hookSrc.indexOf("recognition.start()");
    const cancelIdx = hookSrc.indexOf("speechSynthesis.cancel()");
    expect(startListeningIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeLessThan(startListeningIdx);
  });

  it("maps all Ora language codes to correct BCP-47 tags", () => {
    // Keys are unquoted in object literal; values are quoted strings
    expect(hookSrc).toContain('auto: ""');
    expect(hookSrc).toContain('"en-US"');
    expect(hookSrc).toContain('"ar-SA"');
    expect(hookSrc).toContain('"es-ES"');
    expect(hookSrc).toContain('"fr-FR"');
  });

  it("classifies permission errors as permission_denied (not generic error)", () => {
    expect(hookSrc).toContain('"not-allowed"');
    expect(hookSrc).toContain("permission_denied");
  });

  it("treats no-speech and aborted silently (returns to idle, not error state)", () => {
    expect(hookSrc).toContain('"no-speech"');
    expect(hookSrc).toContain('"aborted"');
    const noSpeechSection = hookSrc.slice(
      hookSrc.indexOf('"no-speech"') - 10,
      hookSrc.indexOf('"no-speech"') + 200,
    );
    expect(noSpeechSection).toContain("idle");
  });

  it("exports all required return fields", () => {
    const required = [
      "voiceState",
      "interimTranscript",
      "isSupported",
      "isSpeechSynthesisSupported",
      "isTtsEnabled",
      "toggleTts",
      "startListening",
      "stopListening",
      "speakText",
      "prepareVoicePlayback",
      "stopSpeaking",
    ];
    for (const field of required) {
      expect(hookSrc, `return must include "${field}"`).toContain(field);
    }
  });
});

describe("Phase 4 — Voice-A: ora-voice-button component", () => {
  const btnSrc = readHook("components/ora/ora-voice-button.tsx");

  it("exports OraVoiceMicButton", () => {
    expect(btnSrc).toContain("export function OraVoiceMicButton");
  });

  it("renders Mic icon for idle state", () => {
    expect(btnSrc).toContain("Mic");
  });

  it("renders Square (stop) icon when listening", () => {
    expect(btnSrc).toContain("Square");
    expect(btnSrc).toContain("isListening");
  });

  it("renders MicOff for unsupported/denied states", () => {
    expect(btnSrc).toContain("MicOff");
    expect(btnSrc).toContain("isInert");
  });

  it("has accessibility aria-label", () => {
    expect(btnSrc).toContain("aria-label");
  });

  it("shows friendly unsupported message (not a hard error)", () => {
    expect(btnSrc).toContain("not supported in this browser");
    expect(btnSrc).toContain("You can still type");
  });

  it("shows friendly permission denied message", () => {
    expect(btnSrc).toContain("Microphone access was denied");
    expect(btnSrc).toContain("browser settings");
  });

  it("has no DB or server imports", () => {
    const forbidden = ["drizzle", "pg", "process.env", "fetch("];
    for (const token of forbidden) {
      expect(btnSrc, `button must not use "${token}"`).not.toContain(token);
    }
  });
});

describe("Phase 4 — Voice-A: ora-panel integration", () => {
  const panelSrc = readHook("components/ora-panel.tsx");

  it("imports useOraVoice", () => {
    expect(panelSrc).toContain("useOraVoice");
  });

  it("imports OraDictationButton", () => {
    expect(panelSrc).toContain("OraDictationButton");
  });

  it("places mic button inside the input bar", () => {
    expect(panelSrc).toContain("<OraDictationButton");
  });

  it("shows interim transcript hint when listening", () => {
    expect(panelSrc).toContain("OraVoiceLiveArea");
    expect(panelSrc).toContain("interimTranscript");
  });

  it("cancels TTS on keydown (typing while Ora speaks)", () => {
    expect(panelSrc).toContain('voice.voiceState === "speaking"');
    expect(panelSrc).toContain("voice.stopSpeaking()");
  });

  it("TTS speaker button is gated on isTtsEnabled (not autoplay)", () => {
    expect(panelSrc).toContain("isTtsEnabled");
    expect(panelSrc).toContain("voice.speakText");
  });

  it("has TTS toggle button in header", () => {
    expect(panelSrc).toContain("toggleTts");
    expect(panelSrc).toContain("VolumeX");
  });

  it("final transcript goes into setInput (review-before-send)", () => {
    expect(panelSrc).toContain("setInput(text)");
    expect(panelSrc).toContain("handleVoiceTranscript");
  });

  it("shows voice error messages without exposing technical details", () => {
    expect(panelSrc).toContain("voiceErrorMsg");
    expect(panelSrc).toContain("browser settings");
  });
});

describe("Phase 4 — Voice-A: ora-bubble integration", () => {
  const bubbleSrc = readHook("components/ora-bubble.tsx");

  it("imports useOraVoice", () => {
    expect(bubbleSrc).toContain("useOraVoice");
  });

  it("imports OraDictationButton", () => {
    expect(bubbleSrc).toContain("OraDictationButton");
  });

  it("places mic button inside the drawer input bar", () => {
    expect(bubbleSrc).toContain("<OraDictationButton");
  });

  it("shows interim transcript hint", () => {
    expect(bubbleSrc).toContain("OraVoiceLiveArea");
    expect(bubbleSrc).toContain("interimTranscript");
  });

  it("cancels TTS when user types", () => {
    expect(bubbleSrc).toContain("voice.stopSpeaking()");
  });

  it("final transcript goes into setInput (review-before-send)", () => {
    expect(bubbleSrc).toContain("setInput(text)");
    expect(bubbleSrc).toContain("handleVoiceTranscript");
  });
});

describe("Phase 4 — Voice-A: voice-session routes stay separate from normal chat", () => {
  it("has a session-gated /transcribe route for Talk to Ora", () => {
    const transcribeSrc = readApiRoute("transcribe.ts");
    expect(transcribeSrc).toContain('router.post("/public-ai/transcribe"');
    expect(transcribeSrc).toContain("validateSession");
  });

  it("has a session-gated /tts route for Talk to Ora natural replies", () => {
    const ttsSrc = readApiRoute("tts.ts");
    expect(ttsSrc).toContain('router.post("/public-ai/tts"');
    expect(ttsSrc).toContain("validateSession");
  });
});

describe("Phase 4 — Voice-A regression: Phase 1 routes still clean", () => {
  const chatSrc = readApiRoute("chat.ts");

  it("chat route still present and exports router", () => {
    expect(chatSrc).toContain("router");
  });

  it("chat route has no audio/transcription references", () => {
    expect(chatSrc).not.toContain("transcribe");
    expect(chatSrc).not.toContain("SpeechRecognition");
    expect(chatSrc).not.toContain("speechSynthesis");
  });
});

describe("Phase 4 — Voice-A regression: Phase 2/3 routes unchanged", () => {
  it("file-analysis route still present", () => {
    const src = readApiRoute("file-analysis.ts");
    expect(src).toContain("router");
  });

  it("dataset-analysis route still present", () => {
    const src = readApiRoute("dataset-analysis.ts");
    expect(src).toContain("router");
  });

  it("upload route still present", () => {
    const src = readApiRoute("upload.ts");
    expect(src).toContain("router");
  });
});
