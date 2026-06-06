---
name: Ora surface-column isolation
description: A surface/tenant column on ora_conversations must be filtered on EVERY single-row endpoint, not just the list query.
---

# Ora surface-column isolation

When a column partitions rows into isolated surfaces (e.g. `ora_conversations.surface` = `normal` | `support`), filtering only the **list** endpoint is not enough. Every single-row endpoint that takes an `:id` — `GET/PATCH/PUT .../messages/DELETE` — must also include the surface predicate in its WHERE clause.

**Why:** the "other" surface (Support Mode) exposes its own conversation IDs to the client. With only the list filtered, a caller can take a support-conversation ID and read or mutate it through the normal `/ora/conversations/:id` endpoints — a cross-surface bypass that defeats the isolation requirement even though ownership (`userId`) still matches.

**How to apply:** whenever you add a surface/tenant/visibility column to a table that already has per-id CRUD routes, audit ALL of them (read, update, message-save, soft-delete) and add `eq(table.surface, "<expected>")` alongside the existing `userId` + `archivedAt` predicates. Mirror the same on the other surface's routes so each side only ever touches its own rows.

## Related: gate cross-domain context on relevance, not availability

Support Mode injects a project's context into the prompt ONLY when the issue is AI-Builder related (`isBuilderRelatedIssue(category, message)` — explicit builder category OR keyword intent), even though a `projectId` is supplied on every chat. Ownership being verified is necessary but NOT sufficient.

**Why:** billing/account/general support chats that happen to carry a `projectId` must not leak project details into the support LLM context. "Have the data + own the data" is not a license to inject it; the issue must actually concern that data.

**How to apply:** when a handler can attach extra context (project, org, file) keyed off an incidental id, gate the injection on an explicit relevance signal, and make the regression test prove the lookup never even ran (assert the table's `.from()` was not called), not just that the rendered output omitted it.
