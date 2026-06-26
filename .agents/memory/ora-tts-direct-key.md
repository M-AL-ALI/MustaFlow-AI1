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

**Merge hazard:** when this direct-key fix is applied independently on two lines of
development with *different* helper names (e.g. `getTtsClient` vs `getDirectOpenAI`)
and a different lazy-singleton var name, a later merge cannot auto-dedupe them — it
yields a duplicate `const client = ...` in the route handler plus a duplicate
singleton var, failing the esbuild build with "symbol 'client' has already been
declared". Avoid by porting the fix with the *same* symbol names everywhere; if a
collision lands, reconcile `tts.ts` to one helper + one `const client` before
restarting api-server (typecheck won't catch it — only the esbuild build does).

**How to apply:** if Talk to Ora is silent or `/api/public-ai/tts` returns 502 with
`INVALID_ENDPOINT`, check that TTS is going through the direct client, not the proxy.
Note: the lib also has a `textToSpeech` helper that uses `gpt-audio` via
`chat.completions` (modalities) — that path can go through the proxy, but it's a different
model/quality and not what the Talk-to-Ora speech route uses.

**Valid model names (the other half of the bug):** `gpt-5-mini-tts` and
`gpt-5-mini-transcribe` DO NOT EXIST. Direct OpenAI returns `404 model_not_found`; the
proxy returns `400 UNSUPPORTED_MODEL`. Either error trips the same silent-failure path
and looks like a voice outage. The working models are **`gpt-4o-mini-tts`** (TTS, direct
client only) and **`gpt-4o-mini-transcribe`** (transcribe, works via proxy). These are the
defaults when `ORA_TTS_MODEL` / `ORA_TRANSCRIBE_MODEL` are unset (they are unset in dev and
prod). **Why:** a plausible-looking but nonexistent model name is easy to introduce and
typecheck/lint never catch it — only a live call does.

**Known still-broken (separate follow-up):** `lib/agent-creative.ts` (creative-agent asset
generation, reached via agent-loop `generateAudioAsset`) calls TTS through the **proxy**
`openai` client's `audio.speech.create`, so it fails with `INVALID_ENDPOINT` regardless of
model. A model-name swap there is a no-op; it needs the same direct-client refactor as the
Ora voice route. Out of scope for the Ora voice fix.
