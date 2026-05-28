---
name: Startup migrations registration
description: Every standalone migrate-*.ts script under scripts/src/ must also be registered in artifacts/api-server/src/lib/startup-migrations.ts or its DDL will silently miss fresh DBs and deployments.
---

The repo has two parallel migration surfaces:

1. **`scripts/src/migrate-*.ts`** — one-off scripts a human runs via `pnpm --filter @workspace/scripts run migrate-<name>`. These are the source of truth for the SQL.
2. **`artifacts/api-server/src/lib/startup-migrations.ts`** — a registry executed automatically on every API server boot, so new environments and deployments self-heal.

**Rule:** any new `migrate-*.ts` script that mutates app-owned tables MUST also be appended to the `MIGRATIONS` array in `startup-migrations.ts` with the same SQL (or an idempotent equivalent). If you skip step 2, the script works on whatever DB the author ran it against and then quietly bit-rots — fresh clones, new deploys, and ephemeral preview DBs will boot missing columns/tables and fail at runtime with `column ... does not exist` / `relation ... does not exist`.

**Documented exception:** `migrate-pg-boss.ts` is intentionally NOT registered — pg-boss owns its own `pgboss.*` schema and auto-creates on first start. There is a stub comment in `startup-migrations.ts` recording this. Any future "library-owns-its-schema" migrations should follow the same pattern: leave a comment in the MIGRATIONS list so the next auditor doesn't re-register it.

**Why:** the two surfaces drift silently — a script can be added to `scripts/` and work on whatever DB the author ran it against, then bit-rot for everyone else. Symptom is always a runtime "column/relation does not exist" on a fresh boot, never a build/typecheck failure.

**How to apply:**

- When adding a migration: write the script, add an `MIGRATIONS.push({ id, sql })` entry in the same PR.
- When reviewing a PR that touches `scripts/src/migrate-*.ts`: reject it unless the matching entry lands in `startup-migrations.ts`.
- When debugging a "column does not exist" error on boot: grep `scripts/src/migrate-` for the column name; if a script exists but the column doesn't, the script was never registered for auto-application.
- Entries must be idempotent (`IF NOT EXISTS`, `DO $$ ... EXCEPTION ... END $$`, etc.) because they re-run every boot.
