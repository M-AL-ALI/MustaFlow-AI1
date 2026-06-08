---
name: Ora memory surfaces & consolidation
description: Where Ora user-memories live, which UI/route manages them, and how supersede-based consolidation works.
---

Ora "memories" (facts Ora remembers about a user) are `knowledge_entries` rows with
`scope="user"`, `origin="ora"`, `type="note"`. Two distinct surfaces touch memory —
do not confuse them:

- **`/api/ora/memories`** (route `ora-memories.ts`, frontend lib `ora-memories.ts`,
  page `ora-memory.tsx` Memory Center) — the ONLY surface that reads/writes
  `origin="ora"` rows. Hand-written authFetch lib, NOT in openapi.yaml (no codegen).
- **`/api/knowledge`** (in-chat `ora-memory-manager.tsx`) — EXCLUDES `origin="ora"`,
  so it manages Builder knowledge only and is irrelevant to Ora user-memories.

Context injection: `buildMemoryContext` in `routes/public-ai/chat.ts` selects the
active Ora memories (enabled, not archived) and injects up to 15.

**Consolidation (supersede):** a `superseded_by INTEGER` column on `knowledge_entries`.
When a new Ora memory overlaps an existing one (e.g. dark→light mode), the old row is
disabled + tagged `superseded_by=newId`; `buildMemoryContext` also filters
`isNull(supersededBy)`. Non-destructive — superseded rows stay listed and have a
Restore action (`POST /ora/memories/:id/restore`).

**Why conservative overlap detection** (`lib/public-ai/memory-consolidation.ts`):
a false "keep both" only repeats old behaviour, but a false merge silently destroys a
distinct fact. Rule requires both rows ≥2 significant tokens, ≥2 SHARED tokens, AND
overlap coefficient |A∩B|/min(|A|,|B|) ≥ 0.6. "like"/"remember" are stopwords so
"like coffee" vs "like tea" never merge; a single shared noun (company Acme vs Globex)
is never enough.
