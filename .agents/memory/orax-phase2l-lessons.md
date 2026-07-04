---
name: Orax Phase 2L applier + AI patch gen
description: Lessons from implementing Phase 2L — real AI patch generation + approval-gated apply in the Orax desktop pipeline.
---

## Key patterns

### skipSharedInsert flag for conditional thread-message inserts
When one branch of an action-event handler needs a custom DB insert (e.g. isDraftPatch with an enriched payload), use a `let skipSharedInsert = false;` boolean declared at the top of the if-block, set it to `true` after the custom insert, and guard the shared insert at the bottom with `if (!skipSharedInsert)`. JavaScript label+break is valid but confusing and should be avoided.

**Why:** The isDraftPatch completed handler builds a richer payload (enrichedDraft + sourceLocalPath) that the shared `{ ...payload }` spread would not include correctly.

**How to apply:** Only the isDraftPatch completed case does a custom insert and sets skipSharedInsert=true. All other cases fall through to the shared insert unchanged.

### apply-patch endpoint lives in orax-projects.ts, not orax-desktop.ts
The project/thread CRUD routes (GET messages, POST continue, GET context) all live in `artifacts/api-server/src/routes/orax-projects.ts`. New per-thread endpoints like apply-patch belong there, not in orax-desktop.ts (which handles host/pairing/command-approval routes).

### ThreadDetail component uses `thread.id` not a `threadId` variable
In `artifacts/mustaflow/src/pages/orax-workspace.tsx`, the ThreadDetail component receives a `thread: OraxThread` prop. The thread's ID is `thread.id`. There is no local `threadId` variable — using it causes TS2552 "Cannot find name 'threadId'".

### AI patch generation: parse defensively
The AI returns JSON that might be wrapped in markdown fences (```json ... ```) or nested under a `changes` key. Strip fences before JSON.parse, and check both top-level array and `parsed.changes` array forms.

### generateAiPatches + computeUnifiedDiffPreview are pure TS (no shell/exec)
Phase 2L kept the no-exec invariant: AI patch gen uses createChatCompletion (fetch-based), and unified diff is computed line-by-line in pure TS with no child_process involvement. All wiring tests assert this explicitly.

### orax-projects.ts: requireProject(projectId, userId) — positional order
Helper signature is `requireProject(projectId: string, userId: string)` — userId is second. Get the order wrong and you get silent null (project looked up under wrong userId).
