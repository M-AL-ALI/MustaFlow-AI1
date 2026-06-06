---
name: Ora sidebar must show standalone conversations
description: Why Ora chat history can appear to "disappear" even though it is safely persisted in the DB.
---

# Ora standalone conversations need a visible home in the sidebar

Ora conversations have an optional `projectId`. The "New conversation" button
creates a chat with `projectId = null` (a standalone chat) — this is the default
path for most casual chats.

**The trap:** if the sidebar only renders conversations nested under user-created
projects (`conversations.filter(c => c.projectId === p.id)`), every standalone
chat is invisible even though it is fully persisted in the DB and returned by
`GET /api/ora/conversations`. To the user this looks like chat history
"suddenly disappeared."

**Rule:** the Ora sidebar must always render a section for standalone
conversations (e.g. a "Recent conversations" list filtering `projectId == null`),
in addition to the project-grouped lists. The two filters
(`projectId == null` vs `projectId === p.id`) are mutually exclusive, so there is
no duplicate rendering.

**Why:** backend list endpoint has no limit and orders by `lastMessageAt desc`,
so the data was never lost — the gap was purely a rendering omission. Any future
change to conversation grouping must keep an always-visible home for unfiled
chats.
