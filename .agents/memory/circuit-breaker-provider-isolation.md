---
name: AI provider circuit breaker isolation
description: openaiCircuit was shared across all providers — Anthropic 400s tripped it and silently blocked the agent loop via CircuitOpenError swallowed by consecutiveErrors.
---

## Rule

Each AI provider (OpenAI, Anthropic, Gemini) must use its own circuit breaker instance. Never share a single breaker across providers.

**Why:** When claude-haiku-4-5 returned HTTP 400 (max_tokens exceeded), the shared openaiCircuit failure counter incremented. After 5 failures, all AI calls — OpenAI AND Anthropic — failed instantly with CircuitOpenError. The agent loop's catch block treated these as model failures, incremented consecutiveErrors, and hit REPEATED_ERROR_CAP in ~1 second. Result: "Refined 0 files" with no visible error.

**How to apply:**

- `resilience.ts`: `openaiCircuit`, `anthropicCircuit`, `geminiCircuit` (all in `ALL_BREAKERS`)
- `ai-providers.ts` `createChatCompletion`: select `circuit` based on `params.provider`
- Agent loop catch block: detect `CircuitOpenError` by `err.constructor.name === "CircuitOpenError"` and break immediately with a user-facing message instead of counting toward `consecutiveErrors`
