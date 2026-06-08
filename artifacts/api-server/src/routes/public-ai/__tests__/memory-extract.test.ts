import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AI provider so extractMemorySaveCandidate doesn't make a real model
// call. Each test sets `mockContent` to the JSON the model would return (or
// configures the mock to throw / return empty to exercise the fail-safe paths).
let mockContent: string | null = "{}";
let mockThrows = false;
let mockDelayMs = 0;

vi.mock("../../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(async () => {
    if (mockDelayMs > 0) await new Promise((r) => setTimeout(r, mockDelayMs));
    if (mockThrows) throw new Error("model unavailable");
    return { choices: [{ message: { content: mockContent } }] };
  }),
}));

import { extractMemorySaveCandidate } from "../../../lib/public-ai/orchestrator";

describe("extractMemorySaveCandidate (model-based)", () => {
  beforeEach(() => {
    mockContent = "{}";
    mockThrows = false;
    mockDelayMs = 0;
  });

  it("returns a low-confidence candidate for a durable fact phrased outside the regex patterns", async () => {
    // "I do all my work in the evenings" matches no MEMORY_SAVE_* regex.
    mockContent = JSON.stringify({
      save: true,
      fact: "Works in the evenings",
      explicit: false,
    });
    const c = await extractMemorySaveCandidate("I tend to do all my work late in the evenings");
    expect(c).not.toBeNull();
    expect(c?.fact).toBe("Works in the evenings");
    expect(c?.confidence).toBe("low");
    expect(c?.sensitive).toBe(false);
  });

  it("returns high confidence when the model flags an explicit save request", async () => {
    mockContent = JSON.stringify({
      save: true,
      fact: "Company is Acme Corp",
      explicit: true,
    });
    const c = await extractMemorySaveCandidate("oh by the way our shop is called Acme Corp");
    expect(c?.confidence).toBe("high");
    expect(c?.sensitive).toBe(false);
  });

  it("returns null for transient chatter the model declines to save", async () => {
    mockContent = JSON.stringify({ save: false, fact: "", explicit: false });
    const c = await extractMemorySaveCandidate("haha that's hilarious, thanks!");
    expect(c).toBeNull();
  });

  it("forces a sensitive fact to low confidence even when the model marks it explicit", async () => {
    // The model paraphrased away the email, but the raw message still carries it
    // — the sensitive guard must catch it from the original message.
    mockContent = JSON.stringify({
      save: true,
      fact: "Contact email on file",
      explicit: true,
    });
    const c = await extractMemorySaveCandidate("remember my email is jane@example.com");
    expect(c?.sensitive).toBe(true);
    expect(c?.confidence).toBe("low");
  });

  it("forces low confidence when the extracted fact itself contains PII", async () => {
    mockContent = JSON.stringify({
      save: true,
      fact: "Phone number is +1 (415) 555-0192",
      explicit: true,
    });
    const c = await extractMemorySaveCandidate("you can reach me at that number above");
    expect(c?.sensitive).toBe(true);
    expect(c?.confidence).toBe("low");
  });

  it("returns null for too-short messages without calling the model", async () => {
    expect(await extractMemorySaveCandidate("hi")).toBeNull();
  });

  it("falls back to the regex detector when the model throws", async () => {
    mockThrows = true;
    // Explicit phrasing the regex detector recognizes — must still work.
    const c = await extractMemorySaveCandidate("remember that I prefer dark mode");
    expect(c).not.toBeNull();
    expect(c?.confidence).toBe("high");
    expect(c?.sensitive).toBe(false);
  });

  it("falls back to the regex detector when the model returns empty content", async () => {
    mockContent = "";
    const c = await extractMemorySaveCandidate("Don't forget I ship to the EU");
    expect(c?.confidence).toBe("high");
  });

  it("falls back to the regex detector when the model returns invalid JSON", async () => {
    mockContent = "not json at all";
    const c = await extractMemorySaveCandidate("keep a note that my budget is $5k");
    expect(c?.confidence).toBe("high");
  });

  it("falls back to the regex detector when the model call exceeds the timeout", async () => {
    process.env.ORA_MEMORY_TIMEOUT_MS = "50";
    mockDelayMs = 300; // slower than the 50ms ceiling
    mockContent = JSON.stringify({ save: true, fact: "ignored", explicit: false });
    const c = await extractMemorySaveCandidate("remember that I prefer dark mode");
    // The slow model result is discarded; regex fallback recognises the explicit phrasing.
    expect(c?.confidence).toBe("high");
    expect(c?.fact).toBe("I prefer dark mode");
    delete process.env.ORA_MEMORY_TIMEOUT_MS;
  });

  it("returns null when the model reports save:true but an empty fact", async () => {
    mockContent = JSON.stringify({ save: true, fact: "   ", explicit: false });
    const c = await extractMemorySaveCandidate("some ambiguous message here");
    expect(c).toBeNull();
  });
});
