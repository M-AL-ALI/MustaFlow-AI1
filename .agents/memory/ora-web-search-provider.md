---
name: Ora web search provider + model choice
description: Ora web_search uses the direct OpenAI key + Responses API; the search MODEL must be fast (gpt-5-mini low effort), not full gpt-5.
---

# Ora web search: direct OpenAI key + Responses API, and a FAST model

Ora's live web search (`lib/public-ai/web-search.ts`) must construct its own
`new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` and call the **Responses
API** with `tools: [{ type: "web_search" }]` on a model that supports it. The
default is chosen by `openAiModelForOraSearch` in `model-router.ts`.

## Model must be fast, or search silently never returns

**Rule:** the search model must be a fast one run at LOW reasoning effort.
Default is `gpt-5-mini` at `reasoning.effort:"low"` on BOTH the normal and
forced paths.

**Why:** the search route has hard timeout caps (`ORA_SEARCH_TIMEOUT_MS`=12s
normal, forced ~26s). If the model is slower than the cap, every search times
out and degrades to a general-knowledge answer (or an honest 503 on forced
retry) — i.e. live search appears to "never work". Live benchmarks against the
prod `OPENAI_API_KEY` proved full **gpt-5** web_search takes 27s (low) / 49s
(low, rerun) / 56s (medium/default) — always over the cap. **gpt-5-mini** at low
effort measured 6.0 / 6.8 / 7.5 / 9.3s — stable, well under 12s, same gpt-5
family, same Responses API + web_search wiring. gpt-4o/4o-mini/4.1/4.1-mini also
work (5-8s) and are still API-active, but gpt-5-mini keeps the "Model 5" family.
Lowering effort on OpenAI reasoning models REDUCES reasoning-token spend of
`max_output_tokens`, so it lowers (not raises) empty-reply risk — unlike Gemini.

**How to apply:** if "live search doesn't work", first suspect model latency vs
the timeout cap, not the wiring. Check `openAiModelForOraSearch`'s default and
that the normal path runs low effort. Env overrides
`ORA_{FREE,CORE,WAVE}_SEARCH_MODEL` → `ORA_SEARCH_MODEL` win over the default,
but are normally unset (so the default is what runs). The default model name is
also asserted in `model-router.test.ts` AND `routing-diagnostics.test.ts` — grep
both when changing it. Mobile TestFlight hits the PROD www API, so a model swap
only takes effect after a republish.

## Why the direct key (not the AI-integrations proxy)

The Replit AI-integrations proxy _accepts_ the `web_search` tool param but
returns unreliable/ungrounded results — no real fetch, missing URL citations.
The direct OpenAI key reliably returns grounded `output_text` plus URL citations
in `output[].content[].annotations[]` (`{type:"url_citation", url, title}`).
`extractSources`/`parseOraMediaBlock` are model-agnostic (parse the Responses
API annotation blocks + reply text), so swapping the model does not break them.

**Security:** citation/media URLs are model/web-sourced and untrusted. Allowlist
`http:`/`https:` only before returning (`isSafeHttpUrl`/`cleanSourceUrl` drop
other schemes) AND re-check on the frontend before rendering an `<a>` — otherwise
`javascript:`/`data:` citations could become clickable links.
