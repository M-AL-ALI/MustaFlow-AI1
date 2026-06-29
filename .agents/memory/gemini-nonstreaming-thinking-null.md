---
name: Gemini non-streaming thinking budget null reply
description: callGemini without disableThinking can return null content when max_completion_tokens is low, causing 502 in non-streaming chat
---

# Gemini 3 non-streaming: thinking eats token budget → null reply → 502

## The Rule
Always pass `disableThinking: true` in `createChatCompletion` calls where `max_completion_tokens` is ≤ 1000 and a real reply is required (Ora chat, suggestions, etc.).

**Why:** Gemini 3 Flash Preview has a silent "thinking" phase. When `thinkingBudget` is unrestricted and `maxOutputTokens` is low (e.g. 450), thinking consumes the entire budget, leaving `candidates[0].content.parts = []` → `text = ""` → `reply = null` → 502. The streaming path (`streamChatCompletion` / `streamGemini`) already had `disableThinking: true` (sets `thinkingConfig: { thinkingBudget: 0 }`), but the non-streaming `createChatCompletion` / `callGemini` path did not.

**How to apply:** Any call to `createChatCompletion({ provider: "gemini", max_completion_tokens: <small number> })` must include `disableThinking: true`. For deep-reasoning use cases (Builder code-gen) that need full thinking, use the streaming path or pass a large `max_completion_tokens` budget.

## Symptom
- `POST /api/public-ai/chat` → 502 "Ora is temporarily unavailable" in production
- `POST /api/public-ai/chat/stream` → 200 (streaming path works fine)
- Prod log shows "Ora chat completion" success log immediately before the 502 (the success log fires before the `!reply` null check)
