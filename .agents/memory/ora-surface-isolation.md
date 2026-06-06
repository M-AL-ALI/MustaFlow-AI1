---
name: Ora surface-column isolation
description: A surface/tenant column on ora_conversations must be filtered on EVERY single-row endpoint, not just the list query.
---

# Ora surface-column isolation

When a column partitions rows into isolated surfaces (e.g. `ora_conversations.surface` = `normal` | `support`), filtering only the **list** endpoint is not enough. Every single-row endpoint that takes an `:id` — `GET/PATCH/PUT .../messages/DELETE` — must also include the surface predicate in its WHERE clause.

**Why:** the "other" surface (Support Mode) exposes its own conversation IDs to the client. With only the list filtered, a caller can take a support-conversation ID and read or mutate it through the normal `/ora/conversations/:id` endpoints — a cross-surface bypass that defeats the isolation requirement even though ownership (`userId`) still matches.

**How to apply:** whenever you add a surface/tenant/visibility column to a table that already has per-id CRUD routes, audit ALL of them (read, update, message-save, soft-delete) and add `eq(table.surface, "<expected>")` alongside the existing `userId` + `archivedAt` predicates. Mirror the same on the other surface's routes so each side only ever touches its own rows.
