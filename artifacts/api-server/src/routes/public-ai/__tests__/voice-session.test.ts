/**
 * Talk to Ora voice-session regression tests.
 *
 * These guard the product split:
 * - composer dictation stays browser/review-before-send,
 * - Talk to Ora uses the Whisper push-to-talk path for transcription,
 * - Talk to Ora uses server-generated TTS for natural voice replies.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const FE_SRC = join(REPO_ROOT, "artifacts", "mustaflow", "src");
const API_SRC = join(REPO_ROOT, "artifacts", "api-server", "src");
const PUBLIC_AI_ROUTES = join(API_SRC, "routes", "public-ai");

function readFe(relPath: string): string {
  return readFileSync(join(FE_SRC, relPath), "utf-8");
}

function readApi(relPath: string): string {
  return readFileSync(join(API_SRC, relPath), "utf-8");
}

function readPublicAiRoute(filename: string): string {
  return readFileSync(join(PUBLIC_AI_ROUTES, filename), "utf-8");
}

describe("Talk to Ora voice-session wiring", () => {
  it("uses a dedicated voice transcription limiter, not the generic upload limiter", () => {
    const transcribe = readPublicAiRoute("transcribe.ts");
    expect(transcribe).toContain("oraVoiceTranscribeLimiter");
    expect(transcribe).not.toContain("oraUploadLimiter");

    const rateLimit = readApi("lib/rateLimit.ts");
    expect(rateLimit).toContain('keyPrefix: "ora_voice_transcribe"');
    expect(rateLimit).toContain('keyPrefix: "ora_voice_tts"');
  });

  it("mounts a session-gated server TTS route for natural voice replies", () => {
    const route = readPublicAiRoute("tts.ts");
    expect(route).toContain('router.post("/public-ai/tts"');
    expect(route).toContain("validateSession");
    expect(route).toContain("oraVoiceTtsLimiter");
    expect(route).toContain("gpt-4o-mini-tts");
    expect(route).toContain('"Content-Type", "audio/mpeg"');

    const index = readPublicAiRoute("index.ts");
    expect(index).toContain('import ttsRouter from "./tts"');
    expect(index).toContain("router.use(ttsRouter)");
  });

  it("keeps normal dictation review-before-send while forcing Talk to Ora through server TTS", () => {
    const hook = readFe("hooks/use-ora-voice.ts");
    expect(hook).toContain("onFinalRef.current(finalText)");
    expect(hook).not.toContain("sendMessage(");
    expect(hook).toContain('fetch("/api/public-ai/tts"');
    expect(hook).toContain("speakTextForce");
  });

  it("does not require browser SpeechRecognition or speechSynthesis for Talk to Ora mode", () => {
    const panel = readFe("components/ora-panel.tsx");
    const bubble = readFe("components/ora-bubble.tsx");

    for (const src of [panel, bubble]) {
      expect(src).toContain("voice.isSupported || whisperConv.isSupported");
      expect(src).toContain("active={voiceConvActive}");
      expect(src).toContain("startWhisperRecording({ autoStop: true })");
      const autoSpeakSection = src.slice(
        src.indexOf("Auto-TTS: speak each new Ora reply"),
        src.indexOf("Conversation cycling: track when Ora finishes speaking"),
      );
      expect(autoSpeakSection).not.toContain("isSpeechSynthesisSupported");
    }

    const button = readFe("components/ora/ora-voice-mode-button.tsx");
    expect(button).toContain("Auto listening");
    expect(button).not.toContain("Hold to speak");
  });
});
