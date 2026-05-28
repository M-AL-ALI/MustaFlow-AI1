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

Developer Mode is the power-user surface: `/dev` home, `/dev/deployments`, `/dev/workspace/:id` (an 18-panel workspace: file tree, Monaco editor, terminal, git, secrets, database, object storage, packages, deployments, resources, preview pane, canvas, tools, integrations search), `/docs/developer-mode`, and the agentic build engine that drives all of it.

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

## B4. Dev-mode chat panel — intent classifier fix
- **What:** The chat panel inside the developer workspace (`dev-workspace/dev-chat-panel.tsx`) was routing every message through the build pipeline — including pure questions like "what does this file do?"
- **How:** Intent classifier now routes conversational messages in dev/zero chat panels to the converse path instead of the build path.
- **Why:** Developers asking a question shouldn't trigger a build.

## B5. Agentic project onboarding (Task #987 — large)
The first time a dev creates an agentic project, the UI walks them through it end to end.

- **Mode selector cards** in the project-creation modal: **Simple** vs **Full-stack** (Server / Database / KeyRound / Rocket icons), with an expandable `FULLSTACK_CHECKLIST` collapsed by default.
- **Anchored 3-step tooltip sequence** (`agentic-onboarding-tooltip.tsx`, rewritten):
  - Uses `createPortal` so cards float above the workspace.
  - Each step positions itself next to its real target via `getBoundingClientRect` (`data-tour="provisioning-badge"`, `data-tab="publishing"`, `data-tab="tools-files"`).
  - Pulsing ring highlights the target, arrow points at it. Falls back to bottom-right corner if the target isn't on screen. No backdrop.
- **Adaptive chat placeholder** for agentic projects (different default text than static projects).
- **In-place upgrade** from `static-legacy` → `agentic`: `useUpdateProject` mutation with a loading spinner; the PATCH handler on the server detects the transition and triggers provisioning + sets `provisioningStatus = "provisioning"`.
- **Defensive guard** at the top of `runProvisionProjectJob` — no-ops immediately when `builderMode !== "agentic"`, preventing accidental infra spin-up for static projects.
- `builderMode` added to `CreateProjectBody` and `ProjectUpdate` schemas (OpenAPI re-generated).
- Side fixes shipped in the same task: deduplicated `getClerkUserById`, installed the missing `svix` package for the Clerk webhook.

## B6. Agentic provisioning — step-by-step UI (Task #988)
- **New columns:** `projects.provisioning_step` (TEXT NULL) and `projects.provisioning_started_at` (TIMESTAMPTZ NULL) via `migrate-provisioning-steps`.
- **EventBus channel:** `provisioning:step:<projectId>` emits `started` / `completed` / `failed` events with a typed `ProvisioningStepPayload`.
- **`provisioning-progress.tsx`** (new component): expandable step-list badge — spinner for active step, green check for done, red X for failed; preserves `provisioningStep` on error so the X shows on the *correct* step.
- **`createContainer` return type** widened from `ContainerInfo | null` to `ContainerInfo | { error: string } | null`. Raw Fly API status + body is propagated to the caller. `humanizeError(error, "fly")` maps 401/403, 429, quota, timeout, 5xx, and network errors to plain-English messages.
- **`/provision/status`** now returns `provisioningStep` and `estimatedSecondsRemaining` so the workspace can show ETA.

## B7. Agentic container reliability (Task #989)
- **`ensureContainerAwake` now fails hard** when `/healthz` doesn't respond in 30s. Previously it returned `ok:true` and let builds start against an unresponsive process.
- **Neon DB health gate** outer catch now returns `ok:false` instead of swallowing decrypt or lookup errors — misconfigured `ENCRYPTION_KEY` and platform DB errors are surfaced to the user.
- **Container sync errors** routed through `mapFlyErrorToMessage`; the task event narration is plain English.
- **"Waking…" health indicator:** when a build is in flight AND container status is `hibernated`, the workspace dot pulses amber and reads "Waking…" instead of "Hibernated".
- **Failed Jobs section:** Retry button now calls `createTask()` directly (one-click re-enqueue) instead of just pre-filling the prompt; shows "Queuing…" spinner; falls back to prompt pre-fill on API error. `elapsedSeconds` shown alongside timestamp; `agentMode` carried on the task type.

## B8. Container cold-start + Build-blocked banner
- **Auto-retry container cold-start** in the pre-flight gate (Task #1056) — first build after hibernation no longer fails on cold cache.
- **"Build blocked" banner** appears when a build fails on container or DB pre-flight, with a structured **suggested fix** (Task #1063).

## B9. Agent loop transparency (Task #990)
This is the single biggest dev-mode change and was previously under-described.

- **`lib/steering-hints.ts`** (new): in-memory `Map` for mid-run steering hints with `setSteeringHint` / `consumeSteeringHint`.
- **`POST /api/projects/:id/tasks/:taskId/steer`** (new route): validates the task is running and writes a hint to the store.
- **`lib/agent-loop.ts`** emits a `loop:step` SSE event at the start of each iteration with `{ stepIndex, stepCap, wallClockElapsedMs, wallClockBudgetMs, toolName }`. It polls the steering store between iterations and injects hints as system messages so a dev can course-correct a running loop without cancelling it. Emits plain-language narration on step-cap or wall-clock termination.
- **`agent-thinking-bubble.tsx`** in the frontend:
  - `LoopProgressBar` redesigned: takes explicit props, accepts `liveWallClockMs` from the parent for smooth 1-second tick interpolation, renders the last tool label under the time bar.
  - Real-time wall-clock interpolation via `setInterval(1000ms)`, reset from the SSE value on each new step event.
  - **Cancel confirmation:** inline "Confirm cancel" / "Keep building" buttons replace the cancel button (no AlertDialog modal).
- **Credit confirmation:** `creditConfirmedRef = useRef(false)` (stable ref, no stale closure) — pre-flight check uses `!creditConfirmedRef.current`; reset to `false` after the guard exits so the next independent build re-confirms.
- **Steering hints persist across server restarts via Redis** (Task #1071) — a steered run survives a deploy.
- **Real-time agent step progress** during builds (Task #960, separate landing of the same theme).

## B10. Agent trace UI (Task #962)
- **`agent-trace-panel.tsx`** (new) shows the exact sequence of tools the agent called, in order, with arguments and outcomes. Reads structured events from the agent-loop SSE stream via `routes/events.ts`.
- **Why:** Power users debugging a build need to see what the model actually did, not just the final diff.

## B11. Opt-in approval gate for risky commands (Task #964)
- **Per-project toggle:** "Require approval for risky commands". When enabled, the agent loop pauses on `bash`, `rm -rf`, package installs, and other destructive operations and waits for the user to approve before executing.

## B12. Quality gate everywhere + architect / staging review
- **Quality gate now runs on all build paths**, not just task-agent builds — previously single-shot refines bypassed it (commit `93b16d26`).
- **Task #991:** Fixed architect findings in the review card, route error 409 mapping, severity normalization in `quality-gate.ts` and `jobs.ts`.
- **Task #992:** Agentic staging review — addressed every architect finding from the prior review round.

## B13. Blueprint `npm install` wiring (Task #1004)
- Blueprint installs now emit proper task events and run through the durable queue with the right safety guards — previously a flaky one-shot.

## B14. AI engine reliability fixes — felt most by dev-mode users
Even though these live in shared platform (Part C1), the symptoms hit dev users hardest because they run longer, more complex loops:
- Agent loop `tool_choice` switched from `"auto"` to `"required"` so the model must call a tool.
- Corrective turn injected when the model returns plain text with no tool calls in refine mode.
- Hard enforcement: agent cannot finalize without file modifications.
- Conversation must end with a user message (Anthropic compatibility) — bridge user message added when needed.
- Provider-isolated circuit breakers so one provider's outage doesn't silently mask others.
- Empty-refine retry now uses the agentic loop instead of the legacy pipeline.

## B15. Admin / job queue (used by dev/admin users)
- Admin job queue and inbox panels switched from hand-written `fetch` calls to generated OpenAPI hooks (commit `43079a34`).
- EAS, app-testing, and CVE jobs registered with the durable pg-boss queue so they survive restarts (commit `56cac9f4`).

## B16. Developer Mode docs (`/docs/developer-mode`)
- Five new deep-dive sections added.
- System prompt hardened.
- Dead breadcrumb link fixed.
- Conclusion section added.

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
| **Developer Mode only (UI + engine)** | B1 slide-out nav swap, B2 composer redesign, B3 brainstorm panel + developer-mode project creation, B4 dev-chat intent classifier, B5 agentic onboarding (mode selector + anchored tooltips + in-place upgrade), B6 provisioning step UI + humanizeError, B7 container reliability + "Waking…" + failed-jobs re-enqueue, B8 cold-start auto-retry + build-blocked banner, B9 agent loop transparency (steering hints, cancel/credit confirm, live step counter), B10 agent trace UI, B11 risky-command approval gate, B12 quality gate everywhere + architect/staging review, B13 blueprint npm install wiring, B14 AI engine reliability (felt hardest by dev users), B15 admin job queue + durable queue, B16 docs |
| **Both surfaces (Shared)** | A3 brainstorm memory + context (panel is shared), C1 AI engine reliability, C2 streaming, C3 agentic provisioning, C4 OpenAPI coverage + /api/docs, C5 voice language sync, C6 billing safety, C7 notifications + activity + emails, C8 GDPR, C9 Knowledge Vault, C10 security/infra |

---

# Day-by-day rhythm

- **May 27 — Reliability and completeness day.** AI engine "0 files refined" fixes, container/streaming reliability, notifications + activity + emails fully wired, GDPR finished, encryption rotation completed, Cloudflare CDN wired, agentic onboarding and provisioning shipped.
- **May 28 — Polish and consistency day.** Unified UI across AI Builder and Developer Mode, full brainstorm memory + context, voice input everywhere with language picker + badge, "Brainstorm-guided" provenance badge.

---

The richer per-task historical detail lives in `docs/changelog.md` (578 lines) — this report is the two-day rollup.
