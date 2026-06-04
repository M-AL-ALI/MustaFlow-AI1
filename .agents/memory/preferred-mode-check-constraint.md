---
name: user_preferences.preferred_mode CHECK constraint enum drift
description: Why "Could not save your preference" on the Ora/Builder mode-select door, and the hidden enum that must be kept in sync.
---

The `user_preferences.preferred_mode` value is validated in FOUR places that must all agree, or saving a new mode silently 500s on the DB write (frontend shows "Could not save your preference"):

1. OpenAPI enum (`lib/api-spec/openapi.yaml`, `UserPreferences` + `UpdatePreferencesBody`)
2. Server Zod (`routes/preferences.ts` `updatePreferencesSchema`)
3. Drizzle column `$type<>` (`lib/db/src/schema/user-preferences.ts`)
4. **Postgres CHECK constraint** `user_preferences_preferred_mode_check` — defined in BOTH `scripts/src/migrate-preferred-mode.ts` AND `artifacts/api-server/src/lib/startup-migrations.ts`

**Why it bit us:** adding `'ora'` to 1–3 looked complete and typechecked, but the live DB CHECK still only allowed `('builder','developer')`, so `INSERT ... preferred_mode='ora'` raised a constraint violation → 500 → the mode-select door could never be saved → users could not enter Ora at all. The route handler has no try/catch, so the SQL error surfaces as a generic mutateAsync rejection.

**How to apply:** when adding a new `preferred_mode` value, update all four. For the CHECK, edit both migration locations AND run the ALTER on the live DB (`DROP CONSTRAINT IF EXISTS` then re-`ADD CONSTRAINT ... CHECK (preferred_mode IN (...))`). Verify with `\d user_preferences`. Same pattern applies to any hard-coded Postgres CHECK enum in this repo.
