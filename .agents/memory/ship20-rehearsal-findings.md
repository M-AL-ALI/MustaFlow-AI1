---
name: Ship 20 rehearsal findings
description: Durable data findings from the A2 workspace-tenancy rehearsal on production data
---

## Backfill count: 6, not 35

The A2 migration brief expected `backfilled=35` (all non-demo projects). Actual is `backfilled=6`.

**Why:** 29 of the 35 non-demo projects already had `workspace_id` set from normal project creation after the workspace_id column was introduced. Only 6 non-demo projects (IDs 17, 18, 24, 25, 26, 48 — all from May 2026) were orphaned with NULL workspace_id.

**Impact:** The migration is correct. `nullAfter=0` is the real invariant. Any future ship brief referencing "35 non-demo projects to backfill" is out of date — that number will be 0 in production after Ship 20 lands.

**Why:** When computing expected backfill counts for future migrations, query production for `COUNT(*) FROM projects WHERE workspace_id IS NULL AND owner_id != 'demo-user'` directly rather than using the total non-demo project count.

## Production project distribution (as of Ship 20 rehearsal, 2026-08-18)

- Total projects: 51
- demo-user projects: 16 (IDs 1–16, all NULL workspace_id before A2)
- Non-demo projects: 35
  - With workspace_id already set: 29 (IDs 19–23, 27–47, 49–51)
  - With NULL workspace_id: 6 (IDs 17, 18, 24, 25, 26, 48)

## Ship 20 gate stamp

Gate stamp commit: `c6b2fdac` (local main, not yet pushed to GitHub as of HOLD decision)
Gate HEAD: `9972dd01` (contains A2 merge + publicWorkspace TS fix)
Gate result: 21/21 PASS, profile=release, 2026-08-18T19:31Z

## publicWorkspace type constraint fix

The A2 branch introduced a `publicWorkspace<T extends { systemKey?: string | null }>` constraint that fails TypeScript when the SELECT query uses `publicWorkspaceFields` (which excludes `systemKey`). Fixed to `T extends Record<string, unknown>` with internal cast. This pattern applies to any future "strip internal field" helper function.

**Why:** Drizzle's SELECT projection types are exact — they only contain selected fields. A type constraint requiring a field not in the projection will always fail, even if the field is optional.
