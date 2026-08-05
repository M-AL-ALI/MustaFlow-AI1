import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AI provider so extractMemorySaveCandidate doesn't make a real model
// call. Each test sets `mockContent` to the JSON the model would return (or
// configures the mock to throw / return empty to exercise the fail-safe paths).
const mockAi = vi.hoisted(() => {
  const state = {
    content: "{}" as string | null,
    throws: false,
    delayMs: 0,
  };
  return {
    state,
    createChatCompletion: vi.fn(async () => {
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.throws) throw new Error("model unavailable");
      return { choices: [{ message: { content: state.content } }] };
    }),
  };
});

vi.mock("../../../lib/ai-providers", () => ({
  createChatCompletion: mockAi.createChatCompletion,
  isDeepSeekAvailable: () => false,
  MODEL_DEFAULTS: {
    openai: {
      lite: "gpt-5-nano",
      eco: "gpt-5-mini",
      power: "gpt-5.4",
      pro: "gpt-5.4",
    },
    anthropic: {
      lite: "claude-haiku-4-5",
      eco: "claude-haiku-4-5",
      power: "claude-sonnet-4-6",
      pro: "claude-opus-4-7",
    },
    gemini: {
      lite: "gemini-3-flash-preview",
      eco: "gemini-3-flash-preview",
      power: "gemini-3.1-pro-preview",
      pro: "gemini-3.1-pro-preview",
    },
    deepseek: {
      lite: "deepseek-chat",
      eco: "deepseek-chat",
      power: "deepseek-reasoner",
      pro: "deepseek-reasoner",
    },
  },
}));

import {
  extractMemorySaveCandidate,
  summarizeDocumentForMemory,
} from "../../../lib/public-ai/orchestrator";

const MEMORY_TEST_ENV_NAMES = [
  "ORA_MEMORY_TIMEOUT_MS",
  "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
  "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
  "AI_INTEGRATIONS_GEMINI_BASE_URL",
  "AI_INTEGRATIONS_GEMINI_API_KEY",
] as const;
const ORIGINAL_MEMORY_TEST_ENV = new Map(
  MEMORY_TEST_ENV_NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of MEMORY_TEST_ENV_NAMES) {
    const original = ORIGINAL_MEMORY_TEST_ENV.get(name);
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
});

describe("extractMemorySaveCandidate (model-based)", () => {
  beforeEach(() => {
    mockAi.state.content = "{}";
    mockAi.state.throws = false;
    mockAi.state.delayMs = 0;
    mockAi.createChatCompletion.mockClear();
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  });

  it("returns a low-confidence candidate for a durable fact phrased outside the regex patterns", async () => {
    // "I do all my work in the evenings" matches no MEMORY_SAVE_* regex.
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Works in the evenings",
      explicit: false,
    });
    const c = await extractMemorySaveCandidate("I tend to do all my work late in the evenings");
    expect(c).not.toBeNull();
    expect(c?.fact).toBe("Works in the evenings");
    expect(c?.confidence).toBe("low");
    expect(c?.sensitive).toBe(false);
    expect(c?.category).toBe("other");
  });

  it("scores plainly stated durable teaching facts as high confidence", async () => {
    const cases = [
      ["my audit codename is Cobalt Finch 805", "Audit codename is Cobalt Finch 805"],
      [
        "my preferred audit beverage is lapsang souchong",
        "Preferred audit beverage is lapsang souchong",
      ],
      ["my audit city is Boise", "Audit city is Boise"],
    ] as const;

    for (const [message, fact] of cases) {
      mockAi.state.content = JSON.stringify({
        save: true,
        fact,
        explicit: false,
        category: "personal",
      });
      const candidate = await extractMemorySaveCandidate(message);
      expect(candidate).toMatchObject({ fact, confidence: "high", sensitive: false });
    }
  });

  it("keeps plainly stated teaching facts saveable when model extraction fails", async () => {
    mockAi.state.throws = true;
    for (const message of [
      "my audit codename is Cobalt Finch 805",
      "my preferred audit beverage is lapsang souchong",
      "my audit city is Boise",
    ]) {
      expect(await extractMemorySaveCandidate(message)).toMatchObject({
        confidence: "high",
        sensitive: false,
      });
    }
  });

  it("returns high confidence when the model flags an explicit save request", async () => {
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Company is Acme Corp",
      explicit: true,
    });
    const c = await extractMemorySaveCandidate("oh by the way our shop is called Acme Corp");
    expect(c?.confidence).toBe("high");
    expect(c?.sensitive).toBe(false);
  });

  it("preserves explicit remember requests when the model incorrectly declines to save", async () => {
    mockAi.state.content = JSON.stringify({ save: false, fact: "", explicit: false });

    const c = await extractMemorySaveCandidate(
      "remember that I use Replit and Codex as my development workflow",
    );

    expect(c).not.toBeNull();
    expect(c?.fact).toBe("I use Replit and Codex as my development workflow");
    expect(c?.confidence).toBe("high");
    expect(c?.category).toBe("project");
  });

  it("lets explicit phrasing override a model that extracts the fact but misses explicitness", async () => {
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Prefers minimum-step answers",
      explicit: false,
      category: "preference",
    });

    const c = await extractMemorySaveCandidate("remember that I prefer minimum-step answers");

    expect(c?.fact).toBe("Prefers minimum-step answers");
    expect(c?.confidence).toBe("high");
    expect(c?.category).toBe("preference");
  });

  it("uses the stronger Core memory extraction model by plan tier", async () => {
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Prefers concise answers",
      explicit: true,
    });
    const c = await extractMemorySaveCandidate("remember that I prefer concise answers", "core");
    expect(c?.fact).toBe("Prefers concise answers");
    expect(c?.category).toBe("preference");
    expect(mockAi.createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5-mini",
      }),
    );
  });

  it("returns null for transient chatter the model declines to save", async () => {
    mockAi.state.content = JSON.stringify({ save: false, fact: "", explicit: false });
    const c = await extractMemorySaveCandidate("haha that's hilarious, thanks!");
    expect(c).toBeNull();
  });

  it("forces a sensitive fact to low confidence even when the model marks it explicit", async () => {
    // The model paraphrased away the email, but the raw message still carries it
    // — the sensitive guard must catch it from the original message.
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Contact email on file",
      explicit: true,
    });
    const c = await extractMemorySaveCandidate("remember my email is jane@example.com");
    expect(c?.sensitive).toBe(true);
    expect(c?.confidence).toBe("low");
  });

  it("forces low confidence when the extracted fact itself contains PII", async () => {
    mockAi.state.content = JSON.stringify({
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
    mockAi.state.throws = true;
    // Explicit phrasing the regex detector recognizes — must still work.
    const c = await extractMemorySaveCandidate("remember that I prefer dark mode");
    expect(c).not.toBeNull();
    expect(c?.confidence).toBe("high");
    expect(c?.sensitive).toBe(false);
  });

  it("falls back to the regex detector when the model returns empty content", async () => {
    mockAi.state.content = "";
    const c = await extractMemorySaveCandidate("Don't forget I ship to the EU");
    expect(c?.confidence).toBe("high");
  });

  it("falls back to the regex detector when the model returns invalid JSON", async () => {
    mockAi.state.content = "not json at all";
    const c = await extractMemorySaveCandidate("keep a note that my budget is $5k");
    expect(c?.confidence).toBe("high");
  });

  it("falls back to the regex detector when the model call exceeds the timeout", async () => {
    process.env.ORA_MEMORY_TIMEOUT_MS = "50";
    mockAi.state.delayMs = 300; // slower than the 50ms ceiling
    mockAi.state.content = JSON.stringify({ save: true, fact: "ignored", explicit: false });
    const c = await extractMemorySaveCandidate("remember that I prefer dark mode");
    // The slow model result is discarded; regex fallback recognises the explicit phrasing.
    expect(c?.confidence).toBe("high");
    expect(c?.fact).toBe("I prefer dark mode");
    delete process.env.ORA_MEMORY_TIMEOUT_MS;
  });

  it("returns null when the model reports save:true but an empty fact", async () => {
    mockAi.state.content = JSON.stringify({ save: true, fact: "   ", explicit: false });
    const c = await extractMemorySaveCandidate("some ambiguous message here");
    expect(c).toBeNull();
  });

  it("accepts a model-provided memory category", async () => {
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Is building a scheduling app for salons",
      explicit: false,
      category: "project",
    });
    const c = await extractMemorySaveCandidate("I'm building a scheduling app for salons");
    expect(c?.category).toBe("project");
  });

  it("falls back to heuristic category when the model category is missing", async () => {
    mockAi.state.content = JSON.stringify({
      save: true,
      fact: "Company is Acme Corp",
      explicit: false,
    });
    const c = await extractMemorySaveCandidate("my company is Acme Corp");
    expect(c?.category).toBe("personal");
  });
});

describe("summarizeDocumentForMemory (model-based)", () => {
  beforeEach(() => {
    mockAi.state.content = "{}";
    mockAi.state.throws = false;
    mockAi.state.delayMs = 0;
    mockAi.createChatCompletion.mockClear();
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
    delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
    delete process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    delete process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  });

  it("uses a plan-aware document memory model and returns the durable summary", async () => {
    mockAi.state.content = JSON.stringify({
      summary: "The document defines Acme's Q3 launch plan and budget constraints.",
    });
    const summary = await summarizeDocumentForMemory(
      "launch-plan.md",
      "Acme Q3 launch plan. Budget capped at $50k.",
      "wave",
    );
    expect(summary).toBe("The document defines Acme's Q3 launch plan and budget constraints.");
    expect(mockAi.createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
      }),
    );
  });
});
