# Ora — Next-Phase Recommendation Report

**Date:** 2026-05-29
**Status: Planning only — no implementation until approved**
**Do not implement anything below without explicit approval.**

---

## Context

Phase 6 (Safe Ora → Builder Handoff) was accepted as complete on 2026-05-29.
This document compares six candidate options for the next Ora phase.

---

## Option 1 — Web Search / Current Information with Citations

### What it is
Ora gains the ability to fetch live web results when a user asks about current events, recent documentation, pricing, frameworks, or anything time-sensitive. Each AI response that uses web data includes visible citations (source URL, title, snippet). Search results are sanitized before injection into the AI context.

### Business value — HIGH
- Eliminates the #1 complaint against AI assistants: stale knowledge cutoff
- Makes Ora competitive with Perplexity, ChatGPT Browse, and Claude.ai
- Users researching what stack to build on (pricing, framework comparisons, API docs) get accurate answers
- Increases trust — cited sources let users verify claims before building on them
- Directly drives Builder conversion: "I found this API, now build it for me"

### User value — HIGH
- Answers questions like "What's the current Stripe pricing?" or "Is Next.js 15 stable?" correctly
- Non-technical users who don't know what's current can ask freely
- Citations teach users what to search for themselves
- Builds confidence in Ora's answers before committing to a build

### Risk level — MEDIUM-HIGH
- Prompt injection from web content is the primary threat — web pages can contain adversarial instructions designed to hijack the AI context
- Result sanitization must be rigorous: strip HTML, scripts, and structured adversarial patterns before injection
- SSRF risk if the search/fetch is done server-side without an allow-list
- Citation spoofing: a malicious site could return content that looks authoritative
- The public Ora route has a strict no-DB-imports isolation boundary — the search module must respect that

### Cost impact — MEDIUM
- Requires a web search API (Brave Search ~$3/1,000 queries or similar)
- At 10% of Ora chats triggering search, this is modest but real
- Each search call adds latency (300–800ms) and AI token cost (injected snippets use token budget)
- Classifier needed to decide when a query warrants a search (avoids unnecessary API calls)

### Security / privacy concerns
- Search queries may contain user PII — must sanitize before sending to search API
- Search results must be labeled as untrusted in the AI context (same pattern as Phase 3 dataset injection)
- No search query logging with user content — only category/intent logged
- Rate limiting per session essential

### Implementation scope — MEDIUM (est. 1 phase)
- `lib/public-ai/web-search.ts` — search API client, result sanitizer, adversarial content filter
- `lib/public-ai/search-classifier.ts` — decides if query is time-sensitive
- `chat.ts` — inject search context block into AI prompt when classifier triggers
- `ora-panel.tsx` / `ora-bubble.tsx` — citation UI component (source chips below AI response)
- Rate limit: 3 searches per session (configurable)
- Kill-switch: `ORA_WEB_SEARCH_ENABLED=false`
- No DB required — result cache optional (in-memory, short TTL)

### Validation plan
- Phase test file: citation rendering, adversarial content stripping, PII sanitization in query, search not triggered for non-time-sensitive queries, session search limit, kill-switch
- Live proof: query with current date, query with known-recent event, adversarial web content injection test
- Regression: all Phase 1–6 tests continue to pass

### Rollback plan
- `ORA_WEB_SEARCH_ENABLED=false` — falls back to standard chat
- Delete `web-search.ts`, `search-classifier.ts`; revert `chat.ts` context injection
- No DB migration

---

## Option 2 — Voice-B API Fallback

### What it is
Voice-A uses the browser's native Web Speech API. Voice-B replaces or supplements this with a server-backed API (e.g., OpenAI Whisper for STT, OpenAI TTS for high-quality read-aloud) for browsers lacking native support or users preferring better voice quality.

### Business value — LOW
- Browser STT/TTS coverage is now >95% on modern browsers (Chrome, Edge, Safari 16+, Firefox)
- Marginal quality improvement unlikely to drive meaningful conversion or retention uplift
- Niche use case for Ora: most users interact by typing

### User value — LOW-MEDIUM
- Whisper gives better accuracy for non-native English speakers and noisy environments
- OpenAI TTS produces noticeably more natural speech than browser TTS
- Meaningful only to the subset of users who actively use voice input/output

### Risk level — LOW
- Well-understood tech with good SDKs
- Audio data must not be logged or stored — standard practice
- Adds a new external API dependency (OpenAI audio endpoints)

### Cost impact — MEDIUM-HIGH
- Whisper STT: ~$0.006/minute
- OpenAI TTS: ~$0.015/1,000 characters (~$0.0045 per typical Ora response)
- Without usage caps, a single heavy user could generate meaningful cost

### Security / privacy concerns
- Audio data (user's voice) sent to OpenAI — must be disclosed in privacy policy
- Audio buffers must not be logged or stored beyond the transcription request
- Only applies when user explicitly activates voice — no passive recording

### Implementation scope — SMALL (est. half a phase)
- `lib/public-ai/voice-stt.ts` — Whisper endpoint wrapper
- `lib/public-ai/voice-tts.ts` — TTS endpoint wrapper
- `ora-panel.tsx` / `ora-bubble.tsx` — fallback to API when browser STT/TTS unavailable
- New upload-style endpoint for audio blobs
- Rate limit: 60s of audio per session
- No DB changes

### Validation plan
- Unit tests: audio format validation, size cap, session limits
- Live proof: voice input transcribed correctly, read-aloud quality comparison

### Rollback plan
- `ORA_VOICE_API_ENABLED=false` — falls back to browser STT/TTS
- No DB migration

---

## Option 3 — Knowledge Vault / Controlled Learning Loop (Planning Only)

### What it is
Ora learns from each conversation — what types of apps users want to build, what features they request, what confuses them. This data populates a per-tenant or per-platform Knowledge Vault that injects relevant context into future Ora prompts. Planning phase only: architecture design, schema, privacy model, and injection strategy.

### Business value — MEDIUM-HIGH (but deferred)
- Long-term moat: Ora gets measurably smarter over time on MustaFlow's specific domain
- Enables personalization: "You built a booking app last week — want to add payment processing?"
- Platform-level learning: common user requests surface as gallery templates automatically
- Differentiator vs. generic AI assistants with no platform-specific knowledge

### User value — HIGH (future)
- Users feel Ora understands their context without re-explaining every session
- Suggestions become increasingly relevant to what MustaFlow users actually want to build
- Can remember user preferences: "prefer React over Vue", "always want mobile-first"

### Risk level — LOW for planning phase; MEDIUM for execution
- Planning only: no code changes, no new security surface
- Execution risks: privacy model complexity, prompt injection risk from stored knowledge, cross-user data bleed if not properly scoped
- The existing Knowledge Vault infrastructure in MustaFlow already exists — this extends it to Ora's public session context

### Cost impact — LOW for planning; MEDIUM for execution
- Planning: no API costs
- Execution: knowledge retrieval adds token budget (the existing `KNOWLEDGE_TOKEN_BUDGET=2400` budget already constrains this)

### Security / privacy concerns
- What gets learned must be rigorously defined — no PII, no raw user quotes, no session content
- Learned patterns must be aggregated/abstracted, not attributed to individuals
- GDPR: `DELETE /api/me` must purge any individual-attributed knowledge entries
- Cross-user isolation: platform-level learnings must not expose one user's data to another

### Implementation scope — PLANNING ONLY
- Design doc: what Ora learns (intent categories, app types, feature popularity) and what it never learns (PII, raw content, session IDs)
- Schema design: `ora_knowledge_entries` table, scope field, extraction pipeline
- Privacy model: extraction rules, GDPR deletion hooks, consent language update
- Injection design: how knowledge is ranked and budget-capped in the Ora prompt
- No code written until planning is approved

### Validation plan
- Design review: privacy model reviewed against GDPR + existing trust.tsx commitments
- Schema migration plan validated before any DB changes
- Injection quality proof: controlled before/after comparison of response relevance

### Rollback plan
- Planning phase: nothing to roll back
- Execution phase: `KNOWLEDGE_RETRIEVAL_ENABLED=false` (already exists) disables injection

---

## Option 4 — Image Editing / Generation (Planning Only)

### What it is
Users can ask Ora to generate UI mockups, icons, hero images, or concept art for the app they are building — or edit images they've uploaded (Phase 5). Planning phase only: model selection, cost model, content moderation strategy, and prompt injection safety design.

### Business value — HIGH (but expensive and complex)
- Image generation is the most-requested AI feature after chat
- Mockup generation directly accelerates the idea → build pipeline
- Competitive: Figma AI, v0.dev, and Lovable all offer visual generation
- Generated images can be injected into the Builder prompt as design references

### User value — HIGH
- Non-designers can get professional-looking UI mockups from natural language
- "Build me an app that looks like this wireframe" unlocks a new Builder workflow
- Users uploading screenshots (Phase 5) could ask Ora to refine or redesign them

### Risk level — HIGH
- Content moderation is non-trivial: image generation can produce harmful, NSFW, or copyright-infringing content
- Must have a moderation layer before returning any generated image
- Model choice matters: DALL-E 3 has built-in moderation; open source models do not
- Generated images stored server-side create a new data category (object storage, lifecycle policy, GDPR deletion)
- Planning phase only: none of these risks materialize until execution

### Cost impact — HIGH
- DALL-E 3: ~$0.040 per 1024×1024 image (standard quality)
- At 5% of Ora sessions triggering image generation, costs are significant
- Credit deduction for image generation is essential
- Storage costs for generated images add up over time

### Security / privacy concerns
- Prompt injection via image generation prompts: users could try to generate ToS-violating content
- Generated images must never contain real people's faces (privacy)
- Object storage lifecycle policy required: generated images expire after N days unless saved to project
- All generation requests logged (prompt hash only, not raw text) for moderation audit

### Implementation scope — PLANNING ONLY
- Model selection: DALL-E 3 vs. Stable Diffusion vs. Flux (quality/cost/moderation tradeoff)
- Credit model: cost per generation, session limits
- Moderation pipeline design: pre-prompt filter + post-generation check
- Object storage design: temporary vs. project-saved images, TTL
- UI design: generation panel within Ora, image preview with save/discard
- No code written until planning is approved

### Validation plan
- Content moderation test suite (adversarial prompts)
- Cost projection model at various usage levels
- Object storage lifecycle proof

### Rollback plan
- Planning phase: nothing to roll back
- Execution phase: `ORA_IMAGE_GENERATION_ENABLED=false`; delete `image-generation.ts`

---

## Option 5 — Advanced Visual Reports / Charts for Dataset Results

### What it is
Phase 3 returns dataset analysis as structured text (column profiles, Pareto analysis, insights). This phase adds interactive charts — bar charts, histograms, scatter plots, correlation matrices — rendered directly in the Ora panel alongside the AI narrative. No new API calls required: the existing `datasetSummary` JSON already contains everything needed.

### Business value — MEDIUM
- Upgrades Phase 3 from "useful" to "impressive" — a concrete demo-able improvement
- Users who upload data expect to see charts, not just text
- Increases session time and the likelihood of converting a dataset user to a Builder user
- No new external API dependencies — pure frontend enhancement

### User value — HIGH for data users
- Charts communicate patterns instantly that text analysis takes 10 sentences to describe
- Non-technical users who upload spreadsheets respond much better to visual output
- Interactive charts (hover, zoom) let users explore their data themselves
- The Pareto data already computed in Phase 3 is ideal for bar/pie charts

### Risk level — LOW
- No new backend routes — purely a frontend enhancement to the existing `dataset-analysis` response
- No new security surface: charts rendered from already-sanitized `datasetSummary` JSON
- Recharts is already installed in the monorepo

### Cost impact — NEGLIGIBLE
- No new API calls
- Recharts already installed in `lib/data-visualization`
- Chart rendering is client-side — zero server cost

### Security / privacy concerns
- Dataset values used for chart axis labels must be the already-sanitized column names and category labels from `datasetSummary` — never raw cell values
- No raw dataset rows are ever sent to the frontend (Phase 3 sends only profile metadata and Pareto summaries)
- No new privacy surface

### Implementation scope — SMALL (est. half a phase)
- `ora-dataset-chart.tsx` — chart component: bar chart for Pareto categories, histogram for numeric columns, correlation heatmap for multi-numeric datasets
- `ora-panel.tsx` / `ora-bubble.tsx` — render `OraDatasetChart` when `msg.datasetSummary` is present
- No backend changes; no new API endpoints; no DB changes
- Kill-switch: `ORA_DATASET_CHARTS_ENABLED=false` (renders text-only fallback)

### Validation plan
- Visual proof: upload CSV → charts render correctly
- Adversarial proof: malformed dataset summary → graceful fallback (text only)
- Regression: Phase 3 tests all pass; chart component renders in isolation

### Rollback plan
- Delete `ora-dataset-chart.tsx`; revert `ora-panel.tsx` and `ora-bubble.tsx`
- No backend changes to undo; no DB migration

---

## Option 6 — Professional Message Actions, Export & Conversation Thread Experience

### What it is
Option 6 is a two-part background UI/UX polish task. It improves Ora's usability, professionalism, accessibility, and report portability without adding new AI models, APIs, backend complexity, or storage costs. It is designed to run as a background task independently of the main roadmap decisions (Web Search, Charts, Knowledge Vault, Voice-B, Image Generation).

**This option is intentionally isolated from:**
- Web Search
- Advanced Charts
- Knowledge Vault
- Voice-B backend fallback
- Image generation/editing
- Database storage
- Permanent message memory
- Analytics tracking of message content
- Billing/credit logic

---

### Part 1 — Message Actions & Export Experience

Ora gains a professional message-action experience directly within the conversation thread. Users can copy, edit, download, reuse, listen to, and continue working from messages without leaving the chat experience. The design follows MustaFlow/Ora visual language and Dynamic Atom styling — not replicating any third-party UI.

A reusable `OraMessageActions` component provides contextual actions for user messages, assistant responses, dataset analyses, image analyses, document analyses, voice transcripts, and Builder handoff responses.

**Actions by message type:**

| Message type | Actions |
|---|---|
| User messages | Copy, Edit (loads into composer, append-only in Phase 1) |
| Assistant messages | Copy, Download (.md), Read aloud (when available), Retry/Regenerate (when safe), Continue in Builder (when applicable) |
| Dataset analysis | Copy summary, Download report (.md), Download JSON, Download action-plan CSV (when available) |
| Image analysis | Copy analysis, Download analysis (.md), Read aloud, Continue in Builder |
| Document analysis | Copy answer, Download report (.md), Read aloud, Continue in Builder |
| Voice transcripts | Copy, Edit transcript text, "Voice transcript" indicator |

**Edit behavior (Phase 1 — append-only):**
- Load prior message into the composer
- User edits and resubmits
- New message is appended; existing thread history preserved
- Marked as "edited from a previous message"
- No destructive thread rewrites
- Future (Option B): branch-style regeneration that replaces original + subsequent messages

**Desktop UI behavior:**
- Actions appear on hover and keyboard focus
- Assistant actions align beneath assistant messages
- User actions align near user messages
- Low-contrast presentation until interaction

**Mobile UI behavior:**
- Compact action pill or overflow menu
- Tap-to-reveal interaction
- Large touch targets (min 44×44px)
- No persistent icon clutter

**Accessibility requirements:**
Every action button must include `aria-label`, tooltip, keyboard accessibility, visible focus state, visible hover state, and mobile-friendly tap targets.

Example labels: "Copy message", "Edit message", "Download response", "Read response aloud", "Regenerate response", "Continue in MustaFlow Builder"

**Download formats:**

| Content | Filename |
|---|---|
| Standard assistant response | `ora-response.md` |
| Dataset analysis | `ora-dataset-analysis.md`, optional `.json`, optional `ora-action-plan.csv` |
| Root-cause analysis | `ora-root-cause-report.md` |
| Image analysis | `ora-image-analysis.md` |
| Document analysis | `ora-document-analysis.md` |

**Implementation guidance:**
- Clipboard: `navigator.clipboard.writeText()`
- Downloads: `Blob` + `URL.createObjectURL()` + `URL.revokeObjectURL()` after completion
- Clipboard fallback: "Copy failed. Please select and copy manually."

**Primary component:** `artifacts/mustaflow/src/components/ora/ora-message-actions.tsx`

**Optional helper module:** `artifacts/mustaflow/src/lib/ora-message-export.ts`

Suggested helper functions: `copyMessageText(message)`, `downloadMessageAsMarkdown(message)`, `downloadDatasetReport(result)`, `downloadActionPlanCsv(actionPlan)`, `formatOraMessageForMarkdown(message)`, `sanitizeFilename(title)`

---

### Part 2 — Conversation Thread Experience

The Ora Panel and Ora Bubble gain a properly scrollable, restorable, and smart-scrolling conversation thread so users can read earlier messages, see all message types in correct order, and always reach the latest message without friction.

**Scrollable thread requirements:**
- Full conversation history is scrollable within the panel/bubble container
- Previous messages remain visible above the current message — the thread does not collapse or truncate history while the session is open
- Input composer is always accessible regardless of thread length (does not scroll out of view)
- Dataset cards, image-analysis results, document-analysis results, voice transcripts, suggestions, and handoff cards remain visible in the correct chronological order
- Message actions (Part 1) work correctly on older messages that have scrolled out of the initial viewport

**Smart auto-scroll:**
- Thread auto-scrolls to the latest message when a new message arrives and the user is already at (or near) the bottom
- If the user has scrolled up to read earlier messages, auto-scroll is suspended — new messages arrive silently without hijacking the user's scroll position
- Auto-scroll resumes when the user scrolls back to the bottom or clicks the "Scroll to latest" button

**"Scroll to latest" / "New message" button:**
- Appears as a fixed affordance within the thread container when the user is scrolled above the bottom
- Shows a "New message" label (without emojis) when a new message has arrived while the user was scrolled up
- Clicking it immediately scrolls to the latest message and resumes auto-scroll
- Disappears automatically when the user reaches the bottom

**Session restore (sessionStorage transcript):**
- When the user refreshes the page or navigates away and back within the same browser session, the existing temporary sessionStorage transcript is restored into the thread
- Message order is preserved exactly
- All message types (chat, dataset, image, document, voice, suggestions, handoff) restore correctly
- Message actions (Part 1) remain functional on restored messages
- No new backend calls required for restore — sessionStorage is the sole source
- Sensitive refs (`fileRef`, `imageRef`, session tokens, handoff tokens) are not written to sessionStorage; restored messages display without re-exposing those references

**Mobile bottom-sheet scrolling:**
- The Ora Bubble bottom sheet scrolls the thread independently of the page scroll
- Overscroll does not accidentally dismiss the sheet while reading earlier messages
- The input composer remains pinned at the bottom of the sheet regardless of thread length
- Touch momentum scrolling works correctly on iOS and Android

**In-scope touch points:**
- `artifacts/mustaflow/src/components/ora-panel.tsx`
- `artifacts/mustaflow/src/components/ora-bubble.tsx`
- Thread scroll container (new or refactored `div` with `overflow-y: auto` and scroll behavior)
- Scroll state management (ref-based, no global store changes needed)
- sessionStorage transcript restore logic (already exists — wire to thread render)

**Out of scope for this option:**
- Permanent server-side message history (no DB, no API changes)
- Cross-session message persistence (sessionStorage only)
- Analytics or logging of scroll behavior or message content
- Any changes to builder.ts, jobs.ts, or AI pipelines

---

### Business value — HIGH
- Makes Ora feel significantly more polished and production-ready
- Improves usability for users who want to read earlier context or reuse AI-generated content
- Reduces friction between discovery and execution workflows
- Encourages Builder conversion through contextual continuation actions
- Increases perceived quality without requiring new AI capabilities
- Creates a stronger enterprise-ready experience for reports and analyses

### User value — HIGH
- One-click copy, edit, download, read-aloud, retry, and continue actions on every message
- Full scrollable thread — no more losing earlier messages
- Automatic scroll that respects user's reading position
- Previous messages restored after browser refresh
- Proper mobile bottom-sheet scrolling
- Improved accessibility and keyboard navigation

### Risk level — LOW-MEDIUM
- Primarily a UI enhancement with no backend impact
- Export functionality must avoid exposing sensitive internal references
- Edit-message workflows must preserve session consistency
- Download generation must remain client-side only
- Scroll state management must not introduce layout regressions
- Retry/regenerate actions must respect existing safety and rate-limit controls

### Cost impact — LOW
- No new AI models required
- No new external APIs required
- Browser Clipboard API, Blob downloads, and CSS scroll behavior are sufficient
- No storage costs — exports generated locally, sessionStorage restore uses existing data

### Security / privacy concerns
- Do not log copied content
- Do not log downloaded content
- Do not log edited message text
- Do not log scroll position or thread length
- Exported content must never expose: `fileRef`, `imageRef`, dataset raw rows, base64 image data, session tokens, handoff tokens, internal identifiers, or Builder/project internals
- Downloads must be generated entirely client-side
- Temporary uploads remain temporary and are never re-exposed through exports
- Edited prompts must not silently reuse expired attachments
- sessionStorage restore must not write or re-expose sensitive refs

### Implementation scope — MEDIUM (est. 1 phase, background task)

No backend changes. No DB migration. No OpenAPI changes. No new external APIs.

Files expected to change:
- `artifacts/mustaflow/src/components/ora/ora-message-actions.tsx` (NEW)
- `artifacts/mustaflow/src/lib/ora-message-export.ts` (NEW, optional)
- `artifacts/mustaflow/src/components/ora-panel.tsx` (scroll container, restore, auto-scroll, "new message" button, message-actions integration)
- `artifacts/mustaflow/src/components/ora-bubble.tsx` (same as panel, mobile bottom-sheet)

### Validation plan

Tests must verify:

**Message actions (Part 1):**
- Copy button renders on assistant messages
- Copy button renders on user messages
- Edit button renders only on user messages
- Download button renders on assistant messages
- Dataset export actions render correctly
- Clipboard API integration works
- Blob download generation works
- Object URLs are revoked after use
- Edit loads content into the composer
- Voice transcript editing behaves as text editing
- No sensitive references appear in exported content (`fileRef`, `imageRef`, base64, session tokens, handoff tokens)
- Keyboard accessibility functions correctly
- Mobile action menu renders correctly

**Thread experience (Part 2):**
- Desktop Ora Panel scrolls through full message history
- Ora Bubble scrolls through full message history
- Mobile bottom-sheet scrolls correctly without dismissing on overscroll
- Previous messages restore correctly after browser refresh (via sessionStorage)
- All message types restore in correct order (chat, dataset, image, document, voice, suggestions, handoff)
- Message actions remain functional on restored messages
- Auto-scroll triggers on new message when user is at bottom
- Auto-scroll is suspended when user has scrolled up
- "Scroll to latest" button appears when scrolled above bottom
- "Scroll to latest" button disappears when user reaches bottom
- "New message" indicator appears when new message arrives while scrolled up
- Input composer remains accessible regardless of thread length

**Regression coverage:** Phase 1 chat, Phase 2 document analysis, Phase 3 dataset analysis, Voice-A, Phase 5 image analysis, Phase 6 Builder handoff

**Validation report requirements (if approved and implemented):**
- Affected files
- Desktop Ora Panel scrolling proof
- Ora Bubble scrolling proof
- Mobile scrolling proof
- Previous messages restore after refresh proof
- Scroll-to-latest button proof
- Copy action proof
- Edit action proof
- Download/export proof
- Dataset report export proof
- No sensitive refs in exported content proof
- No message text in logs proof
- Accessibility proof
- Phase 1–6 regression proof
- Typecheck/lint/format/test status
- Rollback instructions

### Rollback plan
- Remove `ora-message-actions.tsx`
- Remove `ora-message-export.ts`
- Revert scroll container and auto-scroll changes in `ora-panel.tsx` and `ora-bubble.tsx`
- Revert sessionStorage restore wiring (if isolated to a separate hook/util)
- No database migration required
- No backend rollback required

---

## Comparison Matrix

| Criterion | 1 Web Search | 2 Voice-B | 3 Knowledge Vault | 4 Image Gen | 5 Charts | 6 Actions & Thread |
|---|---|---|---|---|---|---|
| **Business value** | HIGH | LOW | MED-HIGH | HIGH | MEDIUM | HIGH |
| **User value** | HIGH | LOW-MED | HIGH (future) | HIGH | HIGH (data) | HIGH |
| **Risk level** | MED-HIGH | LOW | LOW (plan) | HIGH | LOW | LOW-MED |
| **Cost impact** | MEDIUM | MED-HIGH | LOW | HIGH | NEGLIGIBLE | LOW |
| **Security concerns** | HIGH | MEDIUM | MEDIUM | HIGH | LOW | LOW-MED |
| **Implementation scope** | MEDIUM | SMALL | PLAN ONLY | PLAN ONLY | SMALL | MEDIUM |
| **Validation complexity** | HIGH | LOW | N/A | HIGH | LOW | MEDIUM |
| **Rollback simplicity** | Easy | Easy | N/A | Easy | Trivial | Easy |
| **Backend changes** | YES | YES | PLAN ONLY | PLAN ONLY | NO | NO |
| **New external APIs** | YES | YES | NO | YES | NO | NO |
| **DB migration** | NO | NO | YES (future) | NO | NO | NO |

---

## Recommendation

### Recommended priority order

**1. Option 5 — Advanced Visual Charts**

Deliver first. No new backend routes, no new APIs, no new security design — a pure frontend upgrade to Phase 3 that is already proven. The existing Recharts infrastructure means implementation is bounded and testable. Every data user who uploads a spreadsheet immediately gets a better experience. Risk is close to zero. This is the natural "quick win" that completes Phase 3's visual story.

**2. Option 1 — Web Search with Citations**

The highest-capability addition — directly addresses the largest gap in Ora's usefulness for app-building conversations: stale knowledge. Users deciding what to build, what stack to use, or what APIs to integrate need current information. The security design is solvable using the same patterns established in Phases 2 and 3 (untrusted input labeling, content sanitization, rate limiting). The right next full implementation phase.

**3. Option 6 — Professional Message Actions, Export & Conversation Thread Experience**

A strong background task that runs independently of the main roadmap decisions. No backend routes, no new APIs, no DB changes — two complementary frontend improvements: message actions (copy, edit, download, read-aloud, retry, continue) and a properly scrollable, restorable conversation thread with smart auto-scroll and a "new message" indicator. High user value and high business value (enterprise-readiness, report portability, accessibility) at low cost and low risk. Because it is fully isolated from Web Search, Charts, Knowledge Vault, Voice-B, and Image Generation, it can run as a parallel background task without blocking the main roadmap sequence.

**4. Option 3 — Knowledge Vault Planning**

Begin architecture and privacy-model planning in parallel while Options 1 and 6 are being built. Planning-only: no code changes, no risk. Ensures the privacy model is correct before any execution begins.

**5. Option 4 — Image Generation Planning**

Deferred. High value but high cost, content moderation complexity, and storage requirements. Planning-only work appropriate after Options 1 and 3 are resolved.

**6. Option 2 — Voice-B API Fallback**

Lowest priority. Voice-A covers the vast majority of browsers adequately today. Revisit after the platform has a clearer picture of how many users actively use Voice-A and what the quality gap costs in engagement.

---

*Document created: 2026-05-29. Last updated: 2026-05-29.*
*No implementation work begins until each option is explicitly approved.*
