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
const MOBILE_SRC = join(REPO_ROOT, "artifacts", "ora-mobile");
const PUBLIC_AI_ROUTES = join(API_SRC, "routes", "public-ai");

function readFe(relPath: string): string {
  return readFileSync(join(FE_SRC, relPath), "utf-8");
}

function readApi(relPath: string): string {
  return readFileSync(join(API_SRC, relPath), "utf-8");
}

function readMobile(relPath: string): string {
  return readFileSync(join(MOBILE_SRC, relPath), "utf-8");
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

  it("guards the raw-body transcribe stream against hanging on a pre-consumed/aborted request", () => {
    const transcribe = readPublicAiRoute("transcribe.ts");
    // If express.json() already drained the stream (mislabeled application/json),
    // "end" never fires again; the handler must short-circuit instead of hanging.
    expect(transcribe).toContain("req.readableEnded");
    // Client-disconnect mid-upload must also stop the wait, not stall the handler.
    expect(transcribe).toContain('req.once("aborted"');
    expect(transcribe).toContain('req.once("close"');
  });

  it("mounts a session-gated server TTS route for natural voice replies", () => {
    const route = readPublicAiRoute("tts.ts");
    expect(route).toContain('router.post("/public-ai/tts"');
    expect(route).toContain("validateSession");
    expect(route).toContain("oraVoiceTtsLimiter");
    expect(route).toContain("OPENAI_API_KEY");
    expect(route).toContain("gpt-4o-mini-tts");
    expect(route).toContain('"Content-Type", "audio/mpeg"');
    expect(route).not.toContain("@workspace/integrations-openai-ai-server");

    const index = readPublicAiRoute("index.ts");
    expect(index).toContain('import ttsRouter from "./tts"');
    expect(index).toContain("router.use(ttsRouter)");
  });

  it("keeps normal dictation review-before-send while forcing Talk to Ora through server TTS", () => {
    const hook = readFe("hooks/use-ora-voice.ts");
    expect(hook).toContain("onFinalRef.current(finalText)");
    expect(hook).not.toContain("sendMessage(");
    expect(hook).toContain('authFetch("/api/public-ai/tts"');
    expect(hook).toContain("speakTextForce");
    expect(hook).toContain("prepareVoicePlayback");
    expect(hook).toContain("decodeAudioData");
    expect(hook).not.toContain("new Audio(");
  });

  it("does not require browser SpeechRecognition or speechSynthesis for Talk to Ora mode", () => {
    const panel = readFe("components/ora-panel.tsx");
    const bubble = readFe("components/ora-bubble.tsx");

    for (const src of [panel, bubble]) {
      expect(src).toContain("voice.isSupported || whisperConv.isSupported");
      expect(src).toContain("active={voiceConvActive}");
      expect(src).toContain("prepareVoicePlayback()");
      expect(src).toContain("setVoiceConvTtsMuted(false)");
      expect(src).toContain("handleToggleVoiceConvTtsMute");
      expect(src).toContain("voiceRef.current.stopSpeaking()");
      expect(src).toContain("startWhisperRecording({ autoStop: true })");
      const autoSpeakSection = src.slice(
        src.indexOf("Auto-TTS: speak each new Ora reply"),
        src.indexOf("Conversation cycling: track when Ora finishes speaking"),
      );
      expect(autoSpeakSection).not.toContain("isSpeechSynthesisSupported");
      expect(autoSpeakSection).not.toContain("isLoading");
      expect(autoSpeakSection).toContain("playbackKey");
    }

    const button = readFe("components/ora/ora-voice-mode-button.tsx");
    expect(button).toContain("Auto listening");
    expect(button).toContain('"Unmute"');
    expect(button).toContain('"Mute"');
    expect(button).not.toContain('"Voice on"');
    expect(button).not.toContain("Hold to speak");
  });

  it("retries server TTS once after refreshing an expired Ora session", () => {
    const hook = readFe("hooks/use-ora-voice.ts");
    expect(hook).toContain('authFetch("/api/public-ai/tts"');
    expect(hook).toContain("resp.status === 401");
    expect(hook).toContain('authFetch("/api/public-ai/session"');
    expect(hook).toContain("resp = await requestTts()");
  });

  it("cleans Markdown-heavy Ora replies before sending them to server TTS", () => {
    const hook = readFe("hooks/use-ora-voice.ts");
    expect(hook).toContain("cleanOraVoiceReplyForSpeech");
    expect(hook).toContain("const cleaned = cleanOraVoiceReplyForSpeech(trimmed) || trimmed");
    expect(hook).toContain("const spokenText = truncateForTts(cleaned)");
    expect(hook).toContain("JSON.stringify({ text: spokenText, language: lang })");
    expect(hook).toContain("I included a code block in the written reply.");
    expect(hook).toContain("row");
    expect(hook).toContain('.split("|")');
  });

  it("keeps mobile Talk to Ora exit from auto-sending a stale recording transcript", () => {
    const mobileHome = readMobile("app/(home)/index.tsx");
    const toggleStart = mobileHome.indexOf("const toggleTalkMode = useCallback");
    const toggleEnd = mobileHome.indexOf("const openConversations = useCallback", toggleStart);
    const toggleBlock = mobileHome.slice(toggleStart, toggleEnd);

    expect(toggleBlock).toContain("const next = !talkMode");
    expect(toggleBlock).toContain("setTalkMode(next)");
    expect(toggleBlock).toContain("talkModeRef.current = next");
    expect(toggleBlock).toContain("void stopRecordingRef.current()");

    const stopRecordingStart = mobileHome.indexOf("const stopRecording = useCallback");
    const stopRecordingEnd = mobileHome.indexOf("const speak = useCallback", stopRecordingStart);
    const stopRecordingBlock = mobileHome.slice(stopRecordingStart, stopRecordingEnd);
    expect(stopRecordingBlock).toContain("if (talkModeRef.current)");
    expect(stopRecordingBlock).toContain("void sendMessageRef.current(clean, null)");
  });

  it("shows mobile Talk to Ora live status and interrupt controls", () => {
    const mobileHome = readMobile("app/(home)/index.tsx");

    expect(mobileHome).toContain("const [talkModeMuted, setTalkModeMuted]");
    expect(mobileHome).toContain("talkModeMutedRef.current = talkModeMuted");
    expect(mobileHome).toContain("talkModeMutedRef.current = false");
    expect(mobileHome).toContain(
      "const shouldSpeakInTalkMode = talkModeRef.current && !talkModeMutedRef.current",
    );
    expect(mobileHome).toContain("const interruptTalkMode = useCallback");
    expect(mobileHome).toContain("setTimeout(() => void startRecordingRef.current(), 250)");
    expect(mobileHome).toContain("const toggleTalkModeMute = useCallback");
    expect(mobileHome).toContain("onPress={toggleTalkModeMute}");
    expect(mobileHome).toContain("const talkStatusTitle = sending");
    expect(mobileHome).toContain('"Ora is thinking"');
    expect(mobileHome).toContain('"Ora is speaking"');
    expect(mobileHome).toContain('"Transcribing"');
    expect(mobileHome).toContain('"Listening"');
    expect(mobileHome).toContain('"Voice mode active"');
    expect(mobileHome).toContain('"Tap interrupt to speak"');
    expect(mobileHome).toContain('"Muted - replies stay on screen"');
    expect(mobileHome).toContain("onPress={interruptTalkMode}");
    expect(mobileHome).toContain("Interrupt");
    expect(mobileHome).toContain('talkModeMuted ? "Unmute" : "Mute"');
    expect(mobileHome).toContain("End");
  });

  it("auto-stops mobile Talk mode recording only after speech then silence", () => {
    const mobileHome = readMobile("app/(home)/index.tsx");

    expect(mobileHome).toContain("const TALK_MODE_SPEECH_DB = -42");
    expect(mobileHome).toContain("const TALK_MODE_SILENCE_DB = -48");
    expect(mobileHome).toContain("const TALK_MODE_SILENCE_MS = 1200");
    expect(mobileHome).toContain("const autoStopTalkRecording = useCallback");
    expect(mobileHome).toContain("autoStopOnSilence={talkMode}");
    expect(mobileHome).toContain("onAutoStop={autoStopTalkRecording}");
    expect(mobileHome).toContain("heardSpeechRef.current = true");
    expect(mobileHome).toContain("silenceStartedAtRef.current == null");
    expect(mobileHome).toContain("now - silenceStartedAtRef.current >= TALK_MODE_SILENCE_MS");
  });
});
