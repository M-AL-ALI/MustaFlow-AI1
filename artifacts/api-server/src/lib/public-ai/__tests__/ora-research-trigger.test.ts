import { describe, expect, it } from "vitest";
import { isWebSearchRequest } from "../orchestrator";

describe("isWebSearchRequest — time-sensitive / volatile triggers", () => {
  const shouldTrigger: string[] = [
    // ── Pre-existing coverage ─────────────────────────────────────────────────
    "What's the weather today in Dubai?",
    "Latest news on the ceasefire",
    "Bitcoin price right now",
    "Stock price of Apple",
    "Who won the Champions League final?",
    "as of now, what is the inflation rate?",
    // ── Current price beyond market instruments ──────────────────────────────
    "How much does a Tesla Model 3 cost today?",
    "How much does Netflix charge right now?",
    "How much is a Big Mac right now?",
    "What is the current price of oil?",
    "what's the current price of a PS5?",
    // ── Company / service live-status ────────────────────────────────────────
    "Is Bed Bath & Beyond still in business?",
    "Is Twitter still called Twitter?",
    "Is Hertz bankrupt?",
    "Is that airline still operating?",
    "Is the restaurant still open?",
    "Is WeWork shut down?",
    "Is that company still accepting new customers?",
    // ── Current role / position holder ──────────────────────────────────────
    "Who is the current CEO of Microsoft?",
    "Who is the acting president of the company?",
    "Who is the new head of the Federal Reserve?",
    "Who is the current prime minister of the UK?",
    "Who is the latest director of the FBI?",
  ];

  for (const q of shouldTrigger) {
    it(`triggers web search: "${q}"`, () => {
      expect(isWebSearchRequest(q)).toBe(true);
    });
  }
});

describe("isWebSearchRequest — stable factual questions (no trigger)", () => {
  const shouldNotTrigger: string[] = [
    "What is the capital of France?",
    "How does Python handle memory management?",
    "What is a binary search tree?",
    "Explain the difference between TCP and UDP",
    "Who wrote Pride and Prejudice?",
    "What year did World War II end?",
    "How do I reverse a string in JavaScript?",
    "What is photosynthesis?",
    "What is the speed of light?",
    "How do I make a sourdough starter?",
    "What are the main causes of the French Revolution?",
    "Explain recursion to me",
    "What is a JWT token?",
  ];

  for (const q of shouldNotTrigger) {
    it(`does NOT trigger web search: "${q}"`, () => {
      expect(isWebSearchRequest(q)).toBe(false);
    });
  }
});
