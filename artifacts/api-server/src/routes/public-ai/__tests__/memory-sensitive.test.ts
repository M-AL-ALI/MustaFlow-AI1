import { describe, it, expect } from "vitest";
import {
  detectSensitiveFact,
  detectMemorySaveCandidate,
} from "../../../lib/public-ai/orchestrator";

// ─── detectSensitiveFact ─────────────────────────────────────────────────────
describe("detectSensitiveFact", () => {
  const sensitive: Array<[string, string]> = [
    ["email", "my email is jane.doe@example.com"],
    ["phone", "call me at +1 (415) 555-0192"],
    ["credit card", "card 4111 1111 1111 1111"],
    ["ssn", "ssn 123-45-6789"],
    ["password label", "my password is hunter2"],
    ["api key label", "the api key is abcdef123456"],
    ["pin", "pin: 4827"],
    ["stripe-style key", "use sk-ABCDEFGH12345678"],
    ["bearer token", "Authorization Bearer abcdefghijklmnopqrstuvwxyz123"],
    ["street address", "I live at 742 Evergreen Terrace"],
    ["street address (abbrev)", "ship it to 10 Downing St"],
    ["address label", "my home address is somewhere private"],
    ["zip code label", "zip code: 90210"],
    ["iban", "my account is GB29 NWBK 6016 1331 9268 19"],
  ];

  it.each(sensitive)("flags %s as sensitive", (_label, text) => {
    expect(detectSensitiveFact(text)).toBe(true);
  });

  const benign: string[] = [
    "I prefer dark mode",
    "my favorite color is teal",
    "I live in Berlin",
    "remember that I'm a vegetarian",
    "the project ships next quarter",
    "I have three meetings tomorrow",
  ];

  it.each(benign)("does not flag benign fact: %s", (text) => {
    expect(detectSensitiveFact(text)).toBe(false);
  });
});

// ─── detectMemorySaveCandidate sensitive gate ────────────────────────────────
describe("detectMemorySaveCandidate sensitive gate", () => {
  it("forces sensitive explicit candidates to low confidence (blocks auto-save)", () => {
    const c = detectMemorySaveCandidate("remember that my password is hunter2");
    expect(c).not.toBeNull();
    expect(c?.sensitive).toBe(true);
    expect(c?.confidence).toBe("low");
  });

  it("detects sensitive data that lives only in the stripped preamble", () => {
    // "remember my email is …" — the email survives in the cleaned fact too,
    // but the gate must catch it regardless of which copy carries the PII.
    const c = detectMemorySaveCandidate("remember my email is jane@example.com");
    expect(c?.sensitive).toBe(true);
    expect(c?.confidence).toBe("low");
  });

  it("forces a sensitive address candidate to low confidence even with explicit phrasing", () => {
    const c = detectMemorySaveCandidate("remember that I live at 742 Evergreen Terrace");
    expect(c).not.toBeNull();
    expect(c?.sensitive).toBe(true);
    expect(c?.confidence).toBe("low");
  });

  it("keeps high confidence for non-sensitive explicit candidates", () => {
    const c = detectMemorySaveCandidate("remember that I prefer dark mode");
    expect(c).not.toBeNull();
    expect(c?.sensitive).toBe(false);
    expect(c?.confidence).toBe("high");
  });

  it("non-sensitive implicit candidates stay low and not sensitive", () => {
    const c = detectMemorySaveCandidate("my favorite color is teal");
    if (c) {
      expect(c.sensitive).toBe(false);
      expect(c.confidence).toBe("low");
    }
  });

  it("returns null for too-short messages", () => {
    expect(detectMemorySaveCandidate("hi")).toBeNull();
  });
});
