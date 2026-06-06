---
name: Drizzle explicit select drops new columns
description: Adding a column the frontend renders requires updating every explicit .select() projection, not just insert/schema.
---

# Drizzle explicit `.select({...})` silently omits new columns

When a list/GET endpoint uses an explicit Drizzle projection (`.select({ id, name, ... })`)
rather than selecting the whole row, adding a new column to the table + schema + insert
path is NOT enough — the column will be missing from the API payload until you also add
it to every relevant explicit `.select({...})`.

**Why:** the symptom is sneaky: create/POST stores the value fine and the type compiles,
but after a refresh/refetch the list endpoint returns rows without the field, so any UI
bound to it (e.g. an Ora project description subtitle) renders blank only after reload —
easy to miss in a quick same-session click test.

**How to apply:** when you add a column intended for display, grep the route file for
`.select({` on that table and add the column to each projection (especially the list
endpoint), not only the insert and the single-row fetch.
