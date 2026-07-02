---
name: Orax runner AI provider import
description: Dynamic import path for createChatCompletion/resolveStageProvider in orax.ts
---

**Rule:** In `artifacts/api-server/src/routes/orax.ts`, dynamic imports for AI completions must be:

```typescript
const { createChatCompletion, resolveStageProvider, VISION_MODEL } =
  await import("../lib/ai-providers");
```

**Why:** `model-router.ts` exports routing helpers (`selectOraModelRoute`, `runCandidateChain`, etc.) but NOT the execution primitives (`createChatCompletion`, `resolveStageProvider`, `VISION_MODEL`). Those live in `ai-providers`. Using the wrong import path compiles at `await import()` call sites but TypeScript still catches the destructure as TS2339 ("Property does not exist").

**How to apply:** Any new Orax runner function that needs to call the AI (plan summary, attachment analysis, etc.) must use `"../lib/ai-providers"` as the dynamic import target, not `"../lib/public-ai/model-router"`.
