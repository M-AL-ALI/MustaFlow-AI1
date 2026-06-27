import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

describe("Live Voice settings — provider privacy + product voice selector (mobile)", () => {
  const settings = read("../../app/(home)/settings.tsx");
  const types = read("../types.ts");
  const voicePreset = read("../voice-preset.ts");
  const api = read("../api.ts");

  it("never renders the underlying model or a raw provider voice id in the settings screen", () => {
    expect(settings).not.toContain("realtimeDiag.model");
    expect(settings).not.toMatch(/realtimeDiag\.defaultVoice\b/);
    expect(settings).not.toMatch(/gpt-realtime/i);
    expect(settings).not.toMatch(/gpt-5/i);
    expect(settings).not.toMatch(/openai/i);
    expect(settings).not.toMatch(/chatgpt/i);
    // Raw provider voice ids (marin / cedar). The \b keeps "marine" safe.
    expect(settings).not.toMatch(/\bmarin\b/i);
    expect(settings).not.toMatch(/\bcedar\b/i);
  });

  it("offers the Marine and Mustafa product voices via a persisted selector", () => {
    expect(settings).toContain("VOICE_PRESET_LABELS");
    expect(settings).toContain("changeVoicePreset");
    expect(settings).toContain('key: "marine"');
    expect(settings).toContain('key: "mustafa"');
    expect(settings).toContain("realtimeDiag.voices");
    expect(voicePreset).toContain('marine: "Marine"');
    expect(voicePreset).toContain('mustafa: "Mustafa"');
    expect(voicePreset).toContain('VOICE_PRESET_STORAGE_KEY = "ora:voicePreset"');
  });

  it("passes voicePreset through the realtime API and types, hiding model/raw voice from diagnostics", () => {
    expect(api).toContain("voicePreset: ctx.voicePreset");
    expect(types).toContain("export type VoicePreset");
    expect(types).toContain("voicePreset?: VoicePreset");
    expect(types).toContain("defaultVoicePreset");
    expect(types).toContain("defaultVoiceLabel");
  });
});
