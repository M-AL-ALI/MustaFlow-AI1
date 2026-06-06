---
name: Ora TTS needs direct OpenAI key
description: Why Talk to Ora voice (TTS) must bypass the AI-integrations proxy and use OPENAI_API_KEY directly.
---

The Replit AI-integrations proxy (`AI_INTEGRATIONS_OPENAI_BASE_URL` / `_API_KEY`,
exported as `openai` from `@workspace/integrations-openai-ai-server`) does **not**
support OpenAI's `POST /audio/speech` endpoint — it returns
`400 Endpoint: 'POST /audio/speech' is not supported.` (`code: INVALID_ENDPOINT`),
which surfaces as a 502 from `/api/public-ai/tts`.

The proxy DOES support `/audio/transcriptions` (Whisper), so `/api/public-ai/transcribe`
works through it via the lib's `speechToText` helper. Only speech/TTS is rejected.

**Rule:** any code calling `audio.speech.create` (gpt-4o-mini-tts and friends) must use a
**direct** OpenAI client (`new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`), not the
proxy client. Construct it lazily and 503 when the key is absent, so the route degrades
gracefully instead of throwing at import time.

**Why:** the proxy whitelists endpoints; `/audio/speech` is not on it. This is the same
class of limitation as web-search grounding (also needs the direct key). `OPENAI_API_KEY`
is available as a workspace secret and is loaded into the api-server process env.

**How to apply:** if Talk to Ora is silent or `/api/public-ai/tts` returns 502 with
`INVALID_ENDPOINT`, check that TTS is going through the direct client, not the proxy.
Note: the lib also has a `textToSpeech` helper that uses `gpt-audio` via
`chat.completions` (modalities) — that path can go through the proxy, but it's a different
model/quality and not what the Talk-to-Ora speech route uses.
