---
name: Ora saved-memory embeddings & recall
description: Ora memories lack embeddings on save; recall ranks them with a TF-IDF fallback + lazy backfill.
---

Ora's saved memories live in `knowledge_entries` with `scope="user"`, `origin="ora"`.

**Non-obvious gap:** the Ora memory save path inserts rows DIRECTLY without
computing an embedding (it does NOT use `writeKnowledge`, which is the only path
that embeds + dedups). So existing Ora memories generally have `embedding = null`,
and any semantic-similarity recall over them is dead unless embeddings are
backfilled.

**Recall design (relevance-based):** `buildMemoryContext` in
`routes/public-ai/chat.ts` ranks memories like the Builder vault:
cosine×6.0 when an entry has a matching-length embedding, else per-entry TF-IDF
keyword overlap, plus a light recency tiebreaker, trimmed to
`KNOWLEDGE_TOKEN_BUDGET` chars. It tracks an `anySignal` flag separately from the
recency boost so a no-signal query degrades to pure recency (never worse than the
old recency-only path). A fire-and-forget `backfillMemoryEmbeddings` (≤8/call)
gradually embeds memories on read.

**Why:** keeping embeddings off the save path was an explicit scope boundary
("don't change how memories are saved/detected"); backfill-on-read is the
in-scope way to make semantic recall actually fire over time.

**How to apply:** if you ever need semantic search over Ora memories to work
immediately (not eventually), either embed at save time in `ora-memories.ts` or
trigger a batch backfill — don't assume the `embedding` column is populated.
