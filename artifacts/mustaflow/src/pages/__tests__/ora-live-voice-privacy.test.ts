import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PAGES_SRC = join(__dirname, "..");
const SRC = join(__dirname, "..", "..");

const readPage = (rel: string) => readFileSync(join(PAGES_SRC, rel), "utf-8");
const readSrc = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

describe("Live Voice settings — provider privacy + product voice selector (web)", () => {
  const settings = readPage("ora-settings.tsx");
  const hook = readSrc("hooks/use-ora-realtime-voice.ts");

  it("never renders the underlying model or a raw provider voice id in the settings card", () => {
    // The model row is gone; the model is transport-only and never rendered.
    expect(settings).not.toContain('label="Model"');
    expect(settings).not.toContain("diag.model");
    // The raw provider voice field is no longer read in the UI.
    expect(settings).not.toMatch(/diag\.defaultVoice\b/);
    // No provider/model identifiers anywhere in the customer-facing settings page.
    expect(settings).not.toMatch(/gpt-realtime/i);
    expect(settings).not.toMatch(/gpt-5/i);
    expect(settings).not.toMatch(/openai/i);
    expect(settings).not.toMatch(/chatgpt/i);
    // Raw provider voice ids (marin / cedar). The \b keeps the "marine" product
    // label safe (n followed by e is not a word boundary).
    expect(settings).not.toMatch(/\bmarin\b/i);
    expect(settings).not.toMatch(/\bcedar\b/i);
  });

  it("offers the Marine and Mustafa product voices via a persisted selector", () => {
    expect(settings).toContain("VOICE_PRESET_LABELS");
    expect(settings).toContain("handleVoicePresetChange");
    expect(settings).toContain('key: "marine"');
    expect(settings).toContain('key: "mustafa"');
    expect(settings).toContain("diag.voices");
    // Product labels live in the hook's preset map.
    expect(hook).toContain('marine: "Marine"');
    expect(hook).toContain('mustafa: "Mustafa"');
  });

  it("persists the choice and sends voicePreset (not a raw voice) to the mint endpoint", () => {
    expect(hook).toContain('VOICE_PRESET_STORAGE_KEY = "mustaflow_voice_preset"');
    expect(hook).toContain("getStoredVoicePreset");
    expect(hook).toContain("writeStoredVoicePreset");
    expect(hook).toContain("voicePreset,");
  });
});
