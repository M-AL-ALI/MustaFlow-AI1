# Two-Day Build Report — May 27–28, 2026

**Window:** 2026-05-27 00:00 → 2026-05-28 01:30
**Commits:** 92
**Distinct user-facing changes:** ~50
**Task IDs touched:** #229, #951, #954, #955, #960, #961, #962, #964, #965, #980, #987, #988, #989, #990, #991, #992, #996, #998, #1002, #1003, #1004, #1017, #1047, #1051, #1055, #1056, #1057, #1058, #1063, #1071, #1074, #1079, #1091, #1093, #1095, #1097, #1098, #1102, #1103, #1104, #1105, #1112, #1113, #1114, #1115, #1116, #1117 (cancelled in same window: #1111, #1118, #1119, #1120, #1123, #1124, #1127)

---

## How the work splits across surfaces

The product has two front-end surfaces sitting on one shared backend:

- **AI Builder** — the public landing page, `/projects` dashboard, and the AI builder workspace (`/projects/:id`). Aimed at non-technical users.
- **Developer Mode** — `/dev` home, `/dev/deployments`, `/dev/workspace/:id`, and `/docs/developer-mode`. Aimed at engineers driving the agent loop directly.
- **Shared platform** — API server, AI/agent engine, streaming, provisioning, security, GDPR, notifications, knowledge vault, Stripe billing. Powers both surfaces.

The report below is grouped that way.

---

# Part A — AI Builder

## A1. UI consistency on the home and workspace composers
- **What:** The landing/Projects home composer was redesigned with a unified rich-card style: large textarea, Plan / Mic / Discuss / Send bar, and matching pill buttons in the in-workspace chat (`queue-composer.tsx`).
- **How:** Replaced ad-hoc layouts in `projects.tsx` and `pages/projects/[id].tsx`. Removed the legacy tech-chip strip and the "Try: …" rotator.
- **Why:** The composer is the single most-used control. One look, one mental model.
- **Tasks:** #1047 (groundwork), #1091, #1095.

## A2. "Discuss first" Brainstorm panel — wired into AI builder
- **What:** "Discuss first" pill on every composer entry point. On the Projects home it opens a guided brainstorm thread; finishing the brainstorm creates the project. In the workspace chat the same pill opens the full panel.
- **How:** Shared `BrainstormPanel` component with `mode`, `onCreated`, `onResolved`, `storageKey`, `projectId` props. Workspace pill wired in `queue-composer.tsx` (#1097).
- **Why:** Most users describe an idea in fragments. A short guided dialogue produces a much better first prompt.

## A3. Brainstorm memory and context
- **What:**
  - Brainstorm threads persist per location (`brainstorm_messages_<projectId>` in the workspace) and survive panel close/reopen. "Start fresh" button clears them.
  - When you hit "Use this prompt", the full thread is sent to the build AI as a `[BRAINSTORM CONTEXT]` block — not just the one-line prompt.
  - This now also applies to **first builds** when you create a brand-new project from the home brainstorm (#1114).
  - In Build History, tasks that used brainstorm context show a violet "Brainstorm-guided · N turns" pill (#1115).
- **How:** New optional `brainstormContext` field on `ProjectInput` and `ChatMessageInput` schemas in OpenAPI; codegen re-run; server routes (`projects.ts`, `messages.ts`) wrap the turns into a delimited block before sending to the model. New `agent_tasks.has_brainstorm_context` and `brainstorm_turn_count` columns with migration.
- **Why:** A brainstorm only helps if the model actually uses what was said.
- **Tasks:** #1102, #1103, #1114, #1115.

## A4. Voice input on the AI builder home and workspace
- **What:** Mic button on the Projects home composer and on the workspace chat; live language badge bottom-right; in-chat language picker (Auto / en-US / fr-FR / etc.) right next to the mic.
- **How:** Web Speech API behind `use-voice-input` hook with `useSyncExternalStore` so the badge updates across tabs. The picker writes localStorage immediately and best-effort syncs to the server via `PATCH /api/me/preferences`.
- **Why:** Long product descriptions are faster spoken than typed.
- **Tasks:** #1098 (also fixed dictation cutting off after ~1s), #1105, #1112, #1113, #1116.

## A5. Workspace reliability surface
- **What:** Live **connection-quality indicator** in the workspace top bar and in the mobile chat drawer; **"Build blocked" banner** when container/DB preflight fails (with suggested fix).
- **How:** New SSE health probe; banner reads structured error from preflight gate.
- **Why:** Silent freezes were the #1 reported frustration.
- **Tasks:** #1063, #1079.

## A6. Misc polish
- Remembered which "What to look for" tips users dismissed across tasks (#1093).
- Soft-delete gaps fixed on export and duplicate (so deleted projects don't leak out the side door).

---

# Part B — Developer Mode

## B1. Slide-out nav replaces the old DevSidebar
- **What:** `/dev` and `/dev/deployments` now use the same `SlideOutNav` as the AI builder.
- **How:** Direct component swap in `dev-home.tsx` and `dev-deployments.tsx`.
- **Why:** Two products with two sidebars felt incoherent.

## B2. Dev home composer redesigned to match AI builder
- **What:** Dev home `CreationZone` rebuilt with the same textarea + Plan / Mic / Discuss / Send pill bar as the AI builder. Tech chips and "Try:" rotator removed.
- **How:** Edits in `pages/dev-home.tsx`.
- **Why:** Even power users prefer a single consistent composer.

## B3. "Discuss first" Brainstorm panel on Developer Mode home
- **What:** Same Brainstorm panel as AI builder, but on submit it **creates a developer-mode project** and routes the user to `/dev/workspace/:id`.
- **How:** `BrainstormPanel` accepts `mode="developer"` and an `onCreated` callback; panel state is keyed by `brainstorm_dev` localStorage so dev-mode brainstorms persist independently.
- **Why:** Developers benefit just as much from guided ideation before kicking off a build.
- **Tasks:** #1047, #1097, #1103.

## B4. Agent loop transparency (built primarily for dev users)
- **What:** Live agent step counter, mid-run **steering hints**, credit-cost confirmation before expensive runs, and a clean cancel UX. Agent trace UI showing exactly what tools the AI called in what order. Opt-in approval gate before risky shell commands.
- **How:** Steering hints persisted across server restarts via Redis (#1071). Trace UI reads structured events from the agent loop.
- **Why:** Developers running long task-agent loops were flying blind.
- **Tasks:** #960, #962, #964, #990, #991, #992.

## B5. Developer Mode docs
- 5 new deep-dive sections added to `/docs/developer-mode`.
- System prompt hardened.
- Dead breadcrumb link fixed; Conclusion section added.

---

# Part C — Shared platform (powers both surfaces)

## C1. AI builder engine reliability — the "0 files refined" class of bug
- **What/Why:** Users were getting silent "Refined 0 files" outcomes — model replying with text but producing no code.
- **How (root causes and fixes):**
  - **Provider-isolated circuit breakers** — one provider's outage no longer silently masks the others.
  - **Token limit raised** so long refines aren't truncated to empty.
  - **Agent loop `tool_choice` switched from "auto" to "required"** so the model must call a tool.
  - **Corrective turn injected** when the model returns plain text with no tool calls in refine mode.
  - **Empty-refine retry now uses the agentic loop** instead of the legacy pipeline.
  - **Prominent amber double-fail warning** shown to the user.
  - **Retry no longer re-runs** when the user's prompt is a question, not a build instruction.
  - **Intent classifier** routes conversational messages correctly in dev/zero chat panels.
  - **Hard enforcement**: agent can't finalize without file modifications.
  - **Conversation must end with a user message** (Anthropic compatibility — bridge user message added when needed).
- **Tasks:** #229, #951, #954, #955.

## C2. Streaming chat reliability
- **What:** SSE keep-alive heartbeat, auto-reconnect with exponential back-off, **resume from token offset** (instead of replaying the whole response), per-send idempotency keys to prevent duplicate AI replies.
- **How:** Server-side SSE work in `routes/messages.ts`; client retry orchestration in `pages/projects/[id].tsx`.
- **Why:** Long builds were dropping silently when the proxy idled out or the network hiccuped.
- **Tasks:** #1017, #1057, #1074.

## C3. Agentic provisioning (Fly + Neon)
- **What:**
  - Step-by-step progress UI with readable error messages and a completion handoff (#988).
  - Container wake / health gate + DB preflight before kicking off a build (#989).
  - Auto-retry container cold-start in the preflight gate (#1056).
  - Real-time SSE event streams for domain and secret changes (#996).
  - Onboarding for agentic mode: mode selector, checklist, anchored tooltips, adaptive chat, in-place upgrade for legacy projects (#987).
- **How:** New `provisioning_step` and `provisioning_started_at` columns on `projects`; provisioning state machine in `lib/provisioning.ts` with idempotent retries.

## C4. API contract completeness
- **Task #998:** 12 missing endpoints added to OpenAPI; hand-written `fetch` calls in admin job queue and inbox panels replaced with generated hooks.
- OpenAPI coverage added for `POST /projects/{id}/messages/stream`.
- Provisioning step/ETA fields cleaned up; unsafe type assertion removed (#1055).
- SSE event format documented as named OpenAPI schemas (#1051).
- New visual API reference page at **`/api/docs`** powered by Redoc (#1058).

## C5. Voice language preference — server-synced
- New `voice_lang` column on `user_preferences`; exposed via `GET/PATCH /api/me/preferences`; included in GDPR export.
- Tasks: #1104, #1117.

## C6. Billing and credits — money-safety fixes
- **Stripe webhook idempotency race** fixed via status-based deduplication and atomic monthly credit grants — a retried webhook can no longer double-grant credits.
- **Non-atomic credit deduction** replaced everywhere with `deductCreditsAtomic` so concurrent builds can't drive a user negative.

## C7. Notifications, activity log, transactional emails
- Wired build complete / build failed / org invite / publish / @mention notification triggers.
- Wired 4 missing transactional email types (#1003).
- Activity log completeness — rollback, duplicate, delete, invite, comment events now appear (#1002).

## C8. GDPR
- Full data export ZIP (all projects, files, AI chat history, knowledge entries — secrets excluded).
- Proper account erasure moved to a background `gdpr-erasure` worker.
- Body parser limit wired; stale `SESSION_SECRET` removed; `KNOWLEDGE_TOKEN_BUDGET` env var connected.
- `voiceLang` added to export (#1117).

## C9. Knowledge Vault improvements (#980)
- Feedback-weighted retrieval ranking (`USAGE_WEIGHT`, `FEEDBACK_WEIGHT` env-tunable).
- Auto style refresh keeps style guidance current.
- Semantic deduplication stops near-duplicate entries from cluttering retrieval.
- High-quality lessons promoted to cross-project Knowledge Vault.

## C10. Security and infrastructure
- **Encryption key rotation now covers all encrypted columns** — no missed fields during a rotation (#965).
- **Cloudflare R2 CDN uploads wired** with proper Cache-Control headers and per-file retry logic (#961).
- Knowledge route bugs fixed: strip embedding leakage from responses, add Zod validation, batch N+1 inserts.
- Removed orphaned `conversations` table and unused legacy `LoginPage`; Clerk webhook handler properly wired.
- EAS, app-testing, and CVE jobs registered with the durable pg-boss queue so they survive restarts.
- Container "stuck in starting" bug fixed; concurrent wake attempts deduplicated.
- Quality gate now runs on **all** build paths, not just task-agent builds (#990).

---

# Quick answer: which side did each change benefit?

| Surface | Items |
|---|---|
| **AI Builder only (UI)** | A1 home/workspace composer, A2 brainstorm pill on home + workspace, A4 voice on home/workspace, A5 connection indicator + build-blocked banner, A6 dismissed-tip memory |
| **Developer Mode only (UI)** | B1 slide-out nav swap, B2 composer redesign, B3 brainstorm panel on dev home with developer-mode project creation, B4 agent trace UI, agent step counter, steering hints, approval gate, B5 docs |
| **Both surfaces (Shared)** | A3 brainstorm memory + context (panel is shared), C1 AI engine reliability, C2 streaming, C3 agentic provisioning, C4 OpenAPI coverage + /api/docs, C5 voice language sync, C6 billing safety, C7 notifications + activity + emails, C8 GDPR, C9 Knowledge Vault, C10 security/infra |

---

# Day-by-day rhythm

- **May 27 — Reliability and completeness day.** AI engine "0 files refined" fixes, container/streaming reliability, notifications + activity + emails fully wired, GDPR finished, encryption rotation completed, Cloudflare CDN wired, agentic onboarding and provisioning shipped.
- **May 28 — Polish and consistency day.** Unified UI across AI Builder and Developer Mode, full brainstorm memory + context, voice input everywhere with language picker + badge, "Brainstorm-guided" provenance badge.

---

The richer per-task historical detail lives in `docs/changelog.md` (578 lines) — this report is the two-day rollup.
