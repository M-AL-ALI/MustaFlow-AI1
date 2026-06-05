---
name: Ora web search provider choice
description: Why Ora's web_search tool uses the direct OpenAI key + gpt-4o Responses API, not the AI-integrations proxy.
---

# Ora web search uses direct OpenAI key + Responses API web_search

Ora's live web search (`lib/public-ai/web-search.ts`) must construct its own
`new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` and call the **Responses
API** with `tools: [{ type: "web_search" }]` on a model that supports it
(`gpt-4o`, override via `ORA_SEARCH_MODEL`).

**Why:** The Replit AI-integrations proxy (the env used elsewhere, routing
gpt-5.x) *accepts* the `web_search` tool param but returns unreliable/ungrounded
results — no real fetch, missing URL citations. The direct OpenAI key against
gpt-4o reliably returns grounded `output_text` plus URL citations in
`output[].content[].annotations[]` (`{type:"url_citation", url, title}`).

**How to apply:** When a feature needs *real* web grounding, do not assume the
integration proxy executes server-side tools. Use the direct key + Responses API
and parse `output[].content[].annotations[]` for citations. Both
`OPENAI_API_KEY` and the proxy env are present in this repo — pick the direct key
for tool-execution features.

**Security:** Citation URLs are model/web-sourced and untrusted. Allowlist
`http:`/`https:` only before returning them (`isSafeHttpUrl`/`cleanSourceUrl`
drop other schemes) AND re-check on the frontend before rendering as an `<a>` —
otherwise `javascript:`/`data:` citations could become clickable links.
