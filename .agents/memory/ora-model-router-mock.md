---
name: Ora model-router vi.mock must export isDeepSeekAvailable + MODEL_DEFAULTS
description: Tests that import model-router.ts must mock ai-providers with isDeepSeekAvailable and MODEL_DEFAULTS or get 500s from undefined() calls.
---

## The rule

`lib/public-ai/model-router.ts` imports both `isDeepSeekAvailable` and `MODEL_DEFAULTS` as **top-level values** from `../ai-providers` (not inside a handler). Any test that stubs `ai-providers` must include these exports or model-router's module initialisation throws `TypeError: isDeepSeekAvailable is not a function`, which Express 5 propagates as a 500 before any test assertion can run.

**Required mock shape:**

```typescript
vi.mock("../../../lib/ai-providers", () => ({
  createChatCompletion: vi.fn(),
  isDeepSeekAvailable: () => false,
  MODEL_DEFAULTS: {
    openai:    { lite: "gpt-5-nano", eco: "gpt-5-mini", power: "gpt-5.4",        pro: "gpt-5.4" },
    anthropic: { lite: "claude-haiku-4-5", eco: "claude-haiku-4-5", power: "claude-sonnet-4-6", pro: "claude-opus-4-7" },
    gemini:    { lite: "gemini-2.5-flash", eco: "gemini-2.5-flash", power: "gemini-2.5-pro",    pro: "gemini-2.5-pro" },
    deepseek:  { lite: "deepseek-chat",    eco: "deepseek-chat",    power: "deepseek-reasoner", pro: "deepseek-reasoner" },
  },
}));
```

**Why:** Express 5 async error handling propagates any synchronous import-time TypeError as a 500. With a partial mock (only `createChatCompletion`), `isDeepSeekAvailable()` inside `getOraProviderRoutingSnapshot()` fires before the handler body and converts every valid request into a 500, masking all test assertions.

**How to apply:** Check this whenever phase2/phase3/ora-chat tests start returning unexpected 500s — the first thing to verify is whether the `ai-providers` mock is complete.
