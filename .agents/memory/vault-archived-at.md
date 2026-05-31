---
name: vault_entries archived_at column
description: vault_entries uses archived_at for soft-delete, not deleted_at
---

The `vault_entries` table has no `deleted_at` column. Soft-delete uses `archived_at`.

**Why:** The schema was authored with `archived_at` to differentiate "user archived an entry" from a generic soft-delete. The `deleted_at` convention used elsewhere in the app (e.g. `projects`) does not apply here.

**How to apply:** Any query against `vault_entries` that filters out deleted/inactive rows must use `WHERE archived_at IS NULL`, not `WHERE deleted_at IS NULL`. The same applies to Drizzle ORM calls — check the schema file (`lib/db/src/schema/vault.ts`) before writing filters.
