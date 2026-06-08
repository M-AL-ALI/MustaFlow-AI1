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
- The in-chat `ora-memory-manager.tsx` now reads/writes the isolated `/api/ora/memories` endpoints (raw `authFetch` via `lib/ora-memories.ts`), NOT `/api/knowledge`. Saving via `/api/knowledge` is wrong — it stamps `origin='builder'` and leaks into the Builder vault. `lib/ora-memory-save.ts` must POST `/api/ora/memories`.

## Third memory tier: Ora project memory

Ora memory has THREE tiers, all `scope='user'` + `origin='ora'` (NOT a new scope value, NOT Builder's `projectId`):

- **user-level**: `knowledge_entries.ora_project_id IS NULL` — injected into every Ora chat.
- **ora-project**: `ora_project_id = <ora_projects.id>` — persists across every conversation in that Ora project. Uses the dedicated `oraProjectId` column added for this; deliberately separate from Builder's `projectId` (which stays NULL on Ora rows).

**How to apply:**
- Per-message injection (`chat.ts buildMemoryContext`) always pulls user-level memories + (when the body's `oraProjectId` is owned) that project's memories, then relevance-ranks (keyword overlap) within a char budget.
- Standalone Ora chats (no project) get ONLY user-level memory.
- Deleting/cancelling an Ora project (`DELETE /ora/projects/:id`) must also archive that project's memories (`origin='ora'` AND `ora_project_id = id`).
- **Builder read/surface paths must add `sql\`origin IS DISTINCT FROM 'ora'\`\`** (IS DISTINCT FROM keeps legacy NULL-origin rows): Builder vault list + export + AI-injection (`jobs.ts loadKnowledgeContext`) + the publish-to-community endpoint. Other Builder reads filter by `projectId` (non-null) or `type` (style_memory/build/refine/conversation_summary) which Ora rows (projectId null, type note) can never match.

## The reverse rule (Builder must never read Ora memories)

Isolation is bidirectional. Every **Builder-facing** reader of `knowledge_entries` that can feed a build prompt, the Vault UI, or dedup MUST exclude `origin="ora"` via `or(isNull(origin), ne(origin, "ora"))` (NULL origin is legacy/pre-backfill = Builder-owned). Points that need the guard:

- `loadKnowledgeContext` (jobs.ts) — the user-scope branch of the eligibility query had NO origin filter, so personal Ora memories could leak in as "lessons from prior builds". Guard the WHOLE OR (approved-for-reuse + project + user-scope), not just one branch.
- `GET /api/knowledge` (routes/knowledge.ts) — the Builder Vault list UI.
- conversation-summary reader (jobs.ts) and any other prompt-context reader.
- `writeKnowledge` dedup candidate queries (lib/knowledge.ts) — both project and user branches: a Builder write (always `origin="builder"`) must only merge into a Builder row, never an Ora memory, or dedup silently re-tags/overwrites it.

**Why the client save path mattered:** the Ora "Save to memory" chip / auto-save / the duplicate "Ora Memories" section on the Style Memory page all POSTed to `/api/knowledge` (hardcodes `origin="builder"`), misfiling genuine Ora saves into the Vault. Fix repoints the client to `POST /api/ora/memories` and a recovery migration re-tags the misfiled rows: `scope='user' AND origin='builder' AND type='note' AND project_id IS NULL` → `origin='ora'` (EXCLUDE `type='style_memory'` = legit brand profiles + inferred style memories). `promoteHighQualityLessons` is already safe (filters `scope='project'`).

## Confirmed-isolated surfaces (safe)

- System prompts: `ORA_SYSTEM_PROMPT` (lib/public-ai/prompt.ts) vs Builder `BUILD/REFINE/PLAN_SYSTEM_PROMPT` (lib/builder.ts) — distinct, no shared template.
- Model routing: each module has its own `MODEL_FOR_MODE`.
- Conversations: Ora uses `ora_conversations` (JSONB messages) + `ora_projects`; Builder uses `chat_messages` rows keyed by project. Ora's messages route is persistence-only (no AI/pipeline calls). No cross-reads.
- Orchestrator has an explicit isolation contract: must NOT import builder.ts/ai.ts/jobs.ts. It does not auto-route build intent into the Builder.

## Intentional bridges (NOT silent leaks — leave unless user asks for strict isolation)

- `builder_handoff` tool + `/api/public-ai/handoff/*`: user-initiated funnel that hands an Ora conversation summary to the Builder when the user explicitly chooses to build.
- `persistToOraLibrary: true` on Builder-path image jobs (`routes/messages.ts` -> `lib/image-generation-jobs.ts` -> `persistOraAsset`): copies the user's OWN generated image into their unified Ora asset library. User-scoped; does not feed Ora's model context.
