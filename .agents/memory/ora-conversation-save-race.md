---
name: Ora conversation debounced-save race
description: How per-conversation debounced persistence in use-ora-chat avoids writing one conversation's messages into another.
---

# Ora conversation debounced-save race

Ora's chat hook (`use-ora-chat.ts`) debounces saving messages and can switch
between conversations. Two races must be guarded:

1. **Cross-conversation write.** Capture the target conversation id at the
   moment the save is *scheduled* (in `saveToServer`), never resolve it from the
   mutable context ref at flush time. Otherwise sending in conversation A then
   switching to B before the debounce fires persists A's messages into B.
   For a brand-new chat (target id null) only create-on-first-message if the user
   is *still* on a new chat; if they navigated to an existing conversation
   meanwhile, drop the save rather than clobber it.

2. **Stale GET overwrite.** The load effect fetches a conversation's messages on
   selection. Snapshot an `editGenRef` counter (bumped on every `saveToServer`
   call) before the fetch and discard the server payload if the counter advanced
   while the GET was in flight — otherwise a slow load resets the transcript and
   wipes a message the user just typed.

**Why:** these only surface under rapid navigation/typing and silently corrupt
or lose chat history; they are invisible in normal click-through testing.

**How to apply:** any debounced-persistence + selectable-resource hook (not just
Ora) needs id-snapshot-at-schedule + edit-generation-guard on the loader.
