---
name: Ora vs AI Builder separation
description: Ora is a standalone assistant; it must never proactively recommend or hand off to AI Builder. Lists every surface that can leak a proactive handoff.
---

Ora (the public-AI assistant) is a fully standalone product, separate from AI Builder / Agent Zero. It must NEVER proactively recommend building in the Builder or auto-switch modes. A Builder handoff happens ONLY when the user explicitly invokes the dedicated handoff endpoint (`/api/public-ai/handoff/*`).

**Why:** The user explicitly required this — Ora is "a SEPARATE model," not a funnel into the Builder. Treating build-intent as a reason to nudge the user toward the Builder breaks that product contract.

**How to apply — every surface that can leak a proactive handoff:**

- `routes/public-ai/chat.ts` — route ALL messages through `routeOraMessage` (orchestrator). Do NOT re-add classifier/topic/msg-count auto-handoff. A `builder_request` intent must be answered normally (plan/advise), not refused or redirected. Deep/image gating denials use an upgrade CTA, never a handoff CTA.
- `routes/public-ai/file-analysis.ts` and `image-analysis.ts` — keep `handoffCta: false` in responses. These previously returned `true`.
- `components/ora-panel.tsx` and `ora-bubble.tsx` — do NOT render the build-intent `OraHandoffCard` (the `hasBuildIntent(...)`-triggered card). It was removed. The only handoff path left is the explicit `onContinueInBuilder` action gated on `msg.handoffCta`, which no backend path sets proactively.
- `components/ora/build-intent.ts` (`hasBuildIntent`) and `ora/ora-handoff-card.tsx` are now effectively orphaned for proactive use — do not wire them back into the chat feed.

Per-tool credit costs/gating live in `lib/public-ai/orchestrator.ts` (`ORA_TOOL_REGISTRY`), not hard-coded in chat.ts.
