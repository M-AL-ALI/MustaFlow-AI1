---
name: Ora web search provider + model choice
description: Ora web_search uses the direct OpenAI key + Responses API; the search MODEL must be fast AND reliable under the timeout cap — default is gpt-4o-mini (NOT gpt-5-mini, which spiked past the cap).
---

# Ora web search: direct OpenAI key + Responses API, and a FAST model

Ora's live web search (`lib/public-ai/web-search.ts`) must construct its own
`new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` and call the **Responses
API** with `tools: [{ type: "web_search" }]` on a model that supports it. The
default is chosen by `openAiModelForOraSearch` in `model-router.ts`.

## Model must be fast AND reliable under the cap, or search silently degrades

**Rule:** the default search model is **`gpt-4o-mini`** (set in
`openAiModelForOraSearch`). It is fast (~4-9s) and, crucially, LOW-VARIANCE, so
it stays under the timeout cap on essentially every call. Do NOT default to
`gpt-5-mini`.

**Why:** the search route has hard timeout caps (`ORA_SEARCH_TIMEOUT_MS`=12s
normal, forced ~26s). If a call exceeds the cap it times out and degrades to a
general-knowledge answer — live search appears to "never work". The trap is
*variance*, not average latency. gpt-5-mini's average looks fine but live
benchmarks (direct prod `OPENAI_API_KEY`, web_search, low effort) sampled
4.7 / 7.0 / 8.4 / 12.3 / **17.9s** — roughly a quarter of calls EXCEED the 12s
normal cap, and one run returned **0 citations** (ungrounded). That intermittent
spike is exactly the recurring "search still not fixed" complaint; a gpt-5→
gpt-5-mini swap did NOT fix it. gpt-4o-mini benchmarked 3.6-8.9s, 0/4 over cap,
richer grounding (up to 15 citations) — strictly better. Full **gpt-5** is far
worse (27-56s, always over cap). The "Model 5 family" branding is only a soft
preference; reliability wins.

**CRITICAL — reasoning param is model-gated:** the code applies
`reasoning:{effort:"low"}` on both paths, but ONLY gpt-5/o-series accept it.
gpt-4o-mini returns a hard **400 `unsupported_parameter: reasoning.effort`**.
`web-search.ts buildParams` gates it via `supportsReasoningEffort =
/^(?:gpt-5|o\d)/.test(model)`. If you ever point the search default at another
non-reasoning model, that guard must still match — otherwise every search 400s.

**How to apply:** if "live search doesn't work", first suspect model latency
VARIANCE vs the 12s cap, not the wiring. Env overrides
`ORA_{FREE,CORE,WAVE}_SEARCH_MODEL` → `ORA_SEARCH_MODEL` win over the default and
are the revert path (e.g. set `ORA_SEARCH_MODEL=gpt-5-mini` to go back). The
default model name is asserted in `model-router.test.ts` — grep it when changing.
Mobile TestFlight + the published website hit the PROD www API, and
`OPENAI_API_KEY` is a GLOBAL secret (present in prod), so the fix only takes
effect after a **republish**.

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
