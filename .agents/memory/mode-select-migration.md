---
name: Mode-select preferred_mode migration
description: The preferred_mode column in user_preferences requires an explicit migration; db push alone does not add it on existing tables without TTY confirmation.
---

The `user_preferences` table needs a `preferred_mode` column for the mode-select page to function. Without it, `PATCH /api/me/preferences` crashes with "column does not exist" and users cannot navigate past the mode-select screen.

**Migration script:** `pnpm --filter @workspace/scripts run migrate-preferred-mode`

Uses `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS preferred_mode TEXT` plus a check constraint — idempotent, safe to re-run.

**Why:** `pnpm --filter @workspace/db run push` requires interactive TTY confirmation for certain constraint changes and may silently skip them in non-interactive CI/dev contexts. The explicit migration script is reliable.

**How to apply:** Run the migration script on any fresh or restored database before testing the mode-select flow. Also needed in production after deploy.
