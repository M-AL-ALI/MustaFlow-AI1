---
name: Publish "Branch with ID … not found" migration validation failure
description: Stuck publish attempts leave a stale migration-validation branch; the generic "schema conflicts with production data" message can mask a transient infra error.
---

# Publish migration validation: "Branch with ID … not found"

## The rule
When the Publish pane shows "Migrations failed validation … schema changes conflict with existing production data" but the raw error line is `Branch with ID <uuid> not found`, the failure is a stale/expired temporary validation branch from a stuck publish attempt — NOT a real schema/data conflict. Fix = Cancel the stuck deployment, then Republish fresh (a new validation branch is created).

**Why:** A publish sat "in progress" for ~1 hour after a one-column additive change (`agent_tasks.deep_reasoning boolean NOT NULL DEFAULT false`); the validation branch it referenced no longer existed. A full dev↔prod information_schema diff (tables + columns, both directions) showed the single additive column and zero would-be DROPs, proving no genuine conflict existed.

**How to apply:**
1. Before advising, run the two-directional schema diff via executeSql (dev + environment:"production") on information_schema.tables/columns. Additive-only diff ⇒ safe to just cancel + retry.
2. Never recommend "Copy your development database schema & data to production" for a live app — it overwrites prod data wholesale.
3. Never run DDL against prod or add deploy/startup DDL workarounds — the Publish flow is the only supported prod schema path (database skill reference).
4. If a fresh retry reproduces the branch error, it's platform-side → user should contact Replit support.
