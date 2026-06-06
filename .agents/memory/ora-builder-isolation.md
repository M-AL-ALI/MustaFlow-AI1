---
name: Ora <-> AI Builder isolation
description: Which cross-surfaces between the standalone Ora assistant and the AI Builder are isolated vs intentional bridges, and the one silent-leak rule.
---

# Ora must stay separate from the AI Builder

Ora (standalone assistant, `/ora`, served by `public-ai/*` routes + `lib/public-ai/orchestrator.ts`) is a different product from the AI Builder (project chat `routes/messages.ts`, pipelines `lib/builder.ts`). User requirement: keep them separate at the model/context/data level.

## The rule that prevents silent leakage

**Ora may surface/inject ONLY user-approved Ora memories: `knowledge_entries.scope = "user"` AND `origin = "ora"`.** `scope='user'` alone is NOT enough — the Builder also writes user-scope rows (`inferStylePreferences` style_memory, brand profile) that are Builder Knowledge Vault data and must stay out of Ora. The `origin` column (`ora|builder|system|legacy`) is the provenance marker that splits them.

**Why:** the original isolation only filtered `scope='user'`, but all existing user-scope rows were Builder-generated `style_memory` notes (from `inferStylePreferences`) — there was no Ora write path at all, so the new "Saved Memories" tab leaked Builder engineering notes. Fixed by adding `origin`: every Builder insert is tagged `origin='builder'`, the only Ora write path (`POST /ora/memories`) tags `origin='ora'`, and all existing rows were backfilled to `'builder'` (hidden from Ora, never deleted — Builder still uses them).

**How to apply:**
- Any new Ora read path (`ora-memories.ts` userScope, `chat.ts buildMemoryContext`) MUST filter `eq(origin, "ora")` on top of `scope='user'`.
- Any new Builder insert into `knowledge_entries` MUST set `origin: "builder"` (or `"system"` for auto-promotion). `origin` is nullable and defaults to null, so an untagged insert is invisible to Ora but also won't be hidden if a read path forgets the filter — both ends must hold.
- Never reintroduce a `projectId` path into `/public-ai/chat`. `knowledge_entries.scope` defaults to `"project"`, so an unscoped query would pull Builder data.
- The in-chat `ora-memory-manager.tsx` reads `/api/knowledge?scope=user` and filters `type==='note'` client-side; Builder user-scope rows are `type='style_memory'` so they don't leak there, but this is a second Ora surface to keep in mind.

## Confirmed-isolated surfaces (safe)

- System prompts: `ORA_SYSTEM_PROMPT` (lib/public-ai/prompt.ts) vs Builder `BUILD/REFINE/PLAN_SYSTEM_PROMPT` (lib/builder.ts) — distinct, no shared template.
- Model routing: each module has its own `MODEL_FOR_MODE`.
- Conversations: Ora uses `ora_conversations` (JSONB messages) + `ora_projects`; Builder uses `chat_messages` rows keyed by project. Ora's messages route is persistence-only (no AI/pipeline calls). No cross-reads.
- Orchestrator has an explicit isolation contract: must NOT import builder.ts/ai.ts/jobs.ts. It does not auto-route build intent into the Builder.

## Intentional bridges (NOT silent leaks — leave unless user asks for strict isolation)

- `builder_handoff` tool + `/api/public-ai/handoff/*`: user-initiated funnel that hands an Ora conversation summary to the Builder when the user explicitly chooses to build.
- `persistToOraLibrary: true` on Builder-path image jobs (`routes/messages.ts` -> `lib/image-generation-jobs.ts` -> `persistOraAsset`): copies the user's OWN generated image into their unified Ora asset library. User-scoped; does not feed Ora's model context.
