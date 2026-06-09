---
name: Ora search integration tests TDZ on load
description: Why search-*.test.ts files fail to load ("no tests") in isolation and how to make one runnable
---

The Ora web-search integration tests (`search-image-cards`, `search-source-links`, `search-video-cards`, `search-wants-videos` in `routes/public-ai/__tests__/`) declare their OpenAI mock as `const createMock = vi.fn()` and reference it inside a `vi.mock("openai", () => ({ default: class { responses = { create: createMock } } }))` factory.

`vi.mock` is hoisted above the `const`, so when the mocked `openai` module is constructed during the test file's import phase, the class instance-field initializer touches `createMock` while it is still in its temporal dead zone → `ReferenceError: Cannot access 'createMock' before initialization` → the whole file reports "no tests" (it never loads).

**Why:** these files only ran green inside the full suite (module/order side effects); run alone or in a small selection they silently fail to load. Easy to misread as "my change broke the suite."

**How to apply:** to make one of these files runnable in isolation, declare the mock with `const createMock = vi.hoisted(() => vi.fn())`. The other sibling files still carry the original bug — fix only the one you are actively touching unless asked to repair all of them. Separately, `phase2`/`phase3` failures here are ~10s network timeouts (no real AI key) and `voice-session` failures are stale source-text assertions — both pre-existing, not regressions.
