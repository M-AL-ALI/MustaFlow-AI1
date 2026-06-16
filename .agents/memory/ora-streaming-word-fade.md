---
name: Ora streaming per-word fade-in
description: How OraRichText fades in newly streamed words without jitter, and the constraints that keep it flicker-free.
---

Ora streaming text gets a subtle per-word fade-in (ChatGPT-like) implemented in `ora-rich-text.tsx` via a `FadeText` component: it splits text on whitespace runs into index-keyed spans (`ora-fade-word`) carrying a one-shot CSS mount animation (`ora-word-fade`, ~260ms).

**Why it works (do not break these invariants):**
- CSS keyframe animations fire only when an element first **mounts**. Appended words become new spans (new trailing index) → mount → fade. Already-visible words keep their index → React reuses them in place (no remount) → they never re-animate. This is what prevents whole-bubble re-animation and layout jitter on every token.
- The `animate` flag is threaded through `renderInline`/`renderLinkedSegments` and enabled **only for the actively-streaming LAST block** (last heading/paragraph, or last item of the last list). Animating all blocks would risk re-fades when block structure shifts mid-stream.
- When `isStreaming` flips false, everything re-renders as plain `<span>` (no `ora-fade-word`, no animation class) → no final flash.

**How to apply / pitfalls:**
- Never key word spans by content (e.g. `key={word}`) — only by **index**. Content keys would remount on every partial-word growth and re-animate, causing flicker.
- Don't enable fade for tables or code blocks (code renders raw `block.code`; tables stream rarely). Streaming cursor is also intentionally absent inside tables.
- Accept minor remount flicker at markdown syntax boundaries (incomplete `**bold` → `<strong>`, partial URL → link/button, paragraph → list/heading): rare, non-blocking, not broken output.
- Respect `prefers-reduced-motion` (the keyframe block disables the animation), matching `OraStreamCursor`.
- The empty streaming placeholder bubble is skipped in `ora-panel.tsx` (assistant + isStreaming + empty content → return null), so thinking→stream has no empty box / duplicate bubble; the separate loading indicator hides once the first token gives the placeholder content.
