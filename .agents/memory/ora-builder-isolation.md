---
name: Ora <-> AI Builder isolation
description: Which cross-surfaces between the standalone Ora assistant and the AI Builder are isolated vs intentional bridges, and the one silent-leak rule.
---

# Ora must stay separate from the AI Builder

Ora (standalone assistant, `/ora`, served by `public-ai/*` routes + `lib/public-ai/orchestrator.ts`) is a different product from the AI Builder (project chat `routes/messages.ts`, pipelines `lib/builder.ts`). User requirement: keep them separate at the model/context/data level.

## The rule that prevents silent leakage
**Ora's prompt context may inject ONLY user-scoped knowledge (`knowledge_entries.scope = "user"`), never project-scoped (`scope = "project"`).** Project-scoped entries are the Builder's Knowledge Vault, auto-populated by build/refine — injecting them into Ora leaks Builder project knowledge into Ora.

**Why:** `public-ai/chat.ts buildMemoryContext()` previously accepted a `projectId` and OR-ed in `scope='project'` entries for owned projects. The official Ora client never sent `projectId`, so it was dormant, but the endpoint contract allowed the leak. Fixed by removing `projectId` plumbing entirely; `buildMemoryContext(userId)` now filters `scope='user'` only.

**How to apply:** Any future change to Ora context assembly must keep the `scope='user'` filter. Never reintroduce a `projectId` path into `/public-ai/chat`. `knowledge_entries.scope` defaults to `"project"`, so an unscoped query would pull Builder data.

## Confirmed-isolated surfaces (safe)
- System prompts: `ORA_SYSTEM_PROMPT` (lib/public-ai/prompt.ts) vs Builder `BUILD/REFINE/PLAN_SYSTEM_PROMPT` (lib/builder.ts) — distinct, no shared template.
- Model routing: each module has its own `MODEL_FOR_MODE`.
- Conversations: Ora uses `ora_conversations` (JSONB messages) + `ora_projects`; Builder uses `chat_messages` rows keyed by project. Ora's messages route is persistence-only (no AI/pipeline calls). No cross-reads.
- Orchestrator has an explicit isolation contract: must NOT import builder.ts/ai.ts/jobs.ts. It does not auto-route build intent into the Builder.

## Intentional bridges (NOT silent leaks — leave unless user asks for strict isolation)
- `builder_handoff` tool + `/api/public-ai/handoff/*`: user-initiated funnel that hands an Ora conversation summary to the Builder when the user explicitly chooses to build.
- `persistToOraLibrary: true` on Builder-path image jobs (`routes/messages.ts` -> `lib/image-generation-jobs.ts` -> `persistOraAsset`): copies the user's OWN generated image into their unified Ora asset library. User-scoped; does not feed Ora's model context.
