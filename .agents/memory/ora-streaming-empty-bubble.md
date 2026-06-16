---
name: Ora streaming shows an empty bubble + "Replying…" during the pre-first-token gap
description: Frontend render bug where the empty streaming placeholder renders as a blank bubble and the status says "Replying…" over it; the rule for gating the placeholder and the pending indicator.
---

# Ora streaming: don't render the empty placeholder bubble, and base status on the trailing streaming message

Symptom: while Ora is generating (especially the seconds before the first token),
the chat shows a **blank assistant bubble** AND a separate **"Replying…"** indicator
below it. Users read the blank bubble as "it stays empty / broken".

Two independent causes, both in the frontend (ora-panel.tsx + use-ora-chat.ts):

1. An empty streaming placeholder message `{role:"assistant", content:"",
   isStreaming:true}` is appended the moment the request starts so tokens have
   somewhere to land. It was being rendered as a row → a blank bubble during the
   gap. Fix: in the message map, skip rows where
   `role==="assistant" && isStreaming && !content.trim()` (return null). The
   pending state is already represented by the loading indicator.

2. `deriveOraStatus` decided "replying" vs "thinking" by checking whether **any**
   assistant message had content. In a multi-turn chat the earlier replies already
   have content, so it reported "Replying…" over the still-empty new bubble. Fix:
   check only the **trailing** message (`messages[last]`) for
   `isStreaming && content.trim().length>0`.

Also gate the loading indicator with `isLoading && !isStreamingWithContent` so the
dots disappear once real tokens flow (the streaming bubble's own cursor then shows
progress) instead of showing dots + streaming text together.

**Why:** the placeholder must exist in state early (token deltas append to the last
message), but "exists in state" must not mean "rendered as a visible empty row".
Status/indicator visibility must track the *current* turn's streamed text, not the
whole thread.

**How to apply:** any time you add a pre-stream placeholder or a pending indicator,
gate visible rendering on the trailing streaming message having trimmed content —
never on "any assistant message has content". Use `.trim()` on all three checks
(skip-row, indicator gate, status) so a whitespace-only first delta can't flicker.
