---
name: File-gen per-attempt timeout
description: Production fix for file generation hanging past browser disconnect timeout (iOS Safari ~300s)
---

## Rule
`generateFileFromPrompt` in `file-builder.ts` wraps each `createChatCompletion` call in
`Promise.race([fetch, setTimeout(fileGenAttemptTimeoutMs)])`. Default 70 s × 3 candidates = 210 s max, safely under 300 s.

**Why:** For Core-tier users the candidate order is `[anthropic, gemini, openai]`. Anthropic
`claude-sonnet-4-6` was timing out after ~100 s on 9 k-token file responses; Gemini then failed; OpenAI
succeeded at ~360 s — but iOS Safari drops the connection at 300 s, producing "Could not reach Ora"
on the client while the server eventually succeeds. Confirmed in production deployment logs
(`responseTime=299999` abort then `durationMs=362568` fallback success).

**How to apply:** The timeout is per-attempt (not total chain time), so each subsequent fallback
provider gets a fresh 70 s budget. Configurable via `ORA_FILE_GEN_ATTEMPT_TIMEOUT_MS` env var.
The rejected error message `"file-gen-attempt-timeout"` contains the word "timeout" so
`classifyProviderError` classifies it as `ProviderErrorKind="timeout"` → correct `runCandidateChain`
fallback behaviour.

**Do not confuse** with chat streaming timeout — chat uses the streaming endpoint and isn't affected.
