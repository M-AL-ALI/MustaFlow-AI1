---
name: AI proxy intermittent empty content
description: OpenAI proxy can return choices[0].message.content = null; retry pattern and Unicode prompt hygiene
---

The Replit AI integration proxy occasionally returns a structurally valid ChatCompletion response where `choices[0].message.content` is `null` or empty. This is not an exception — `withRetry` does not catch it. Without explicit handling, the caller silently fails.

**Why:** Intermittent proxy-level behavior (possibly content filtering or transient empty flush). Frequency is low but non-zero; happens more with longer structured prompts.

**How to apply:**
1. After calling `createChatCompletion`, check `choices?.[0]?.message?.content` before using it.
2. Retry once (1–2 s gap) before returning an error. A single retry resolves the issue in practice.
3. Avoid Unicode box-drawing characters (`═`, `─`, `│`) in prompt strings; replace with plain ASCII (`---`, `|`). These multi-byte chars can cause proxy truncation that yields empty content.

Pattern:
```typescript
let reportText = "";
for (let attempt = 1; attempt <= 2; attempt++) {
  const result = await createChatCompletion({ ... });
  const text = result.choices?.[0]?.message?.content?.trim() ?? "";
  if (text) { reportText = text; break; }
  if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
}
if (!reportText) { /* fail */ }
```
