---
name: Post-merge migration pattern
description: After task agent merges, drizzle-kit db push fails non-interactively; individual migration scripts are the reliable path.
---

After each task agent merge, the post-merge script runs `pnpm --filter @workspace/db run push` which requires an interactive TTY for column-conflict resolution. It silently fails for new columns, leaving the DB out of sync with the schema.

**Symptoms:** HTTP 500 on any route that INSERTs or SELECTs the new column. Error: `column "X" of relation "Y" does not exist`.

**Fix:** Run the specific migration script for the missing column:
- `pnpm --filter @workspace/scripts run migrate-<name>`
- All migrations live in `scripts/src/migrate-*.ts` and are listed in `scripts/package.json`
- `pnpm --filter @workspace/scripts run migrate-all-outstanding` runs all 60+ in order but can stall on long-running ones (e.g. background-jobs); prefer targeted scripts when you know what's missing.

**Columns that have needed manual migration after merges:**
- `user_preferences.preferred_mode` → `migrate-preferred-mode`
- `projects.canvas_state` → `migrate-canvas-state`
- `projects.project_mode` → `migrate-project-mode`

**Why:** drizzle-kit's interactive prompts require `process.stdin.isTTY` to be true. The post-merge CI shell is non-interactive, so it exits with an error that the script treats as non-fatal.

**How to apply:** When a new column is added by a task, immediately run its migration script. Check `replit.md` "Migrations" section for the full list.
