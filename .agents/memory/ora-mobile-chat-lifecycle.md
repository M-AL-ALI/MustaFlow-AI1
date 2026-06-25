---
name: Ora Mobile chat list memoization + app lifecycle
description: Why memoized chat bubbles need ref-backed callbacks, and why backgrounding needs a TTS generation guard, in the Expo Ora chat screen.
---

# Memoized chat bubbles must use ref-backed callbacks

When the Ora chat message list memoizes its row component (React.memo with a
comparator keyed on the message object ref + a few render-affecting props), any
callback prop handed to a row that closes over render state becomes a
**stale-closure hazard** for settled rows that no longer re-render.

**Why:** the non-memoized version recreated every handler on each render, so
stale closures were silently masked. Once rows are memoized, a settled bubble
keeps the exact closure it had when it last rendered. Concretely observed:
- a handler that mapped over a captured `messages` array → `setMessages(stale)`
  **drops newer turns (data loss)**;
- a save handler closing over `persist` (which closes over `conversationId`)
  fired before the conversation existed → **saved to the wrong/duplicate
  conversation**.

**How to apply:** any callback passed to the memoized bubble must either capture
only its own row's message (identical to the compared `message`) or read live
values through refs (messages / sending / persist / isSignedIn / speak…) with
empty deps so it stays stable. Do NOT add a churning callback (deps that change
per streaming token, e.g. `messages`) to the comparator — that re-renders every
bubble per token and defeats the optimization. The streaming updater must keep
unchanged messages' object references so the comparator can skip them.

# Backgrounding needs a generation guard against late async TTS

The text-to-speech path awaits several async steps (synthesize → write temp file
→ set audio mode) before it creates and plays an audio player. If the app is
backgrounded mid-synthesis, those awaits can resolve afterward and start
playback while the user has already left.

**Why:** tearing down the current player on background is not enough — an
in-flight `speak()` call still holds its own local state and will create a fresh
player after the teardown ran.

**How to apply:** keep a generation counter ref; bump it in the AppState
`background` handler (alongside removing the player, clearing speakingId, and
stopping any active recorder). Capture the counter at the start of `speak()` and
re-check it after all awaits, immediately before creating the player — if it
changed, abort without creating/playing anything. Handle only `background` (not
`inactive`) so transient app-switcher peeks don't tear down the voice loop.
In-flight SSE chat streams are intentionally left running.
