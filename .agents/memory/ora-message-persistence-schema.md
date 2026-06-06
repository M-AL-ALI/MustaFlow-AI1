---
name: Ora message persistence schema mirroring
description: Why Ora chat reload loses source cards / inline images / memory chips, and the contract that prevents it.
---

The Ora frontend serializes rich per-message UI state in `serializeForStorage`
(use-ora-chat.ts) — web-search `sources`, inline `imageUrl`/`imageId`/
`editInstruction`, and memory-save chip fields. That state is persisted via the
backend message PUT routes, which validate the body with a Zod `messageSchema`
defined **twice**: `routes/ora-conversations.ts` and `routes/ora-transcript.ts`.

**Rule:** any new persisted per-message field must be added to BOTH `messageSchema`
copies, or Zod silently drops it on save and the conversation reloads degraded.

**Why:** a prior version of the schema omitted those fields, so signed-in users
who reloaded saw plain text bubbles — no source cards, no inline images, no
edit lineage, no memory chips. The bug was invisible because the write path
succeeds (the field is just stripped, not rejected).

**How to apply:**

- `imageUrl` is a hosted/remote URL (never base64) — safe to persist under the
  256KB payload cap. `generatedFile.fileData` (base64 bytes) is intentionally
  stripped via `.transform()`; the frontend must render a non-interactive
  "Regenerate to download" card when `fileData` is absent on a reloaded message
  (guarded in both ora-panel.tsx and ora-bubble.tsx).
