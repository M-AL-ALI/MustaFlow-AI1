---
name: admin.ts task-agent merge revert pattern
description: Task-agent merges repeatedly revert targeted fixes to admin.ts because agents work from a stale base. Documents which fixes keep getting reverted and how to repair them fast.
---

## The pattern

Every task-agent merge that touches `artifacts/api-server/src/routes/admin.ts` partially or fully reverts previously applied fixes. The merge uses `git merge` (ort strategy) but the task agent's branch was based on an earlier HEAD that didn't include the fixes. The auto-merge resolves conflicts by keeping the task-agent's version of conflicting hunks.

**Why:** Task agents are initialized with the codebase at branch-cut time. If fixes land on main after the agent started, the agent's branch doesn't have them. Git auto-merge keeps one side and discards the other on conflicting regions.

**How to apply:** After every push-to-github that shows "Auto-merging artifacts/api-server/src/routes/admin.ts", run `pnpm --filter @workspace/api-server run typecheck` and `pnpm run lint` immediately — don't fire the stability gate until both pass.

## Fixes that keep getting reverted

### 1. GET /admin/me — INSERT with undefined `role`
Reverted to:
```ts
const [row] = await db
  .insert(userRolesTable)
  .values({ userId: userId.trim(), role: role!, grantedBy: req.userId ?? "system" })
  .onConflictDoUpdate({ ... })
  .returning();
```
Correct fix:
```ts
const [row] = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId));
```

### 2. Calibration endpoint — wrong table + unclosed try
Reverted to querying `userCreditsTable` or leaving `buildTokenTelemetryRows` unassigned inside an unclosed `try {}`.
Correct: `db.execute<{...}>(sql\`SELECT mode, COUNT(*)::int, AVG(computed_usd_cost::float) FROM build_token_telemetry WHERE ... GROUP BY mode\`)` then map rows and close `try { ... } catch { /* non-fatal */ }`.

### 3. Inbox endpoint — duplicate import + wrong query
Reverted to duplicate `const { eq, desc, sql } = await import("drizzle-orm")` lines and querying `userCreditsTable`.
Correct: single `const { eq, desc, sql: drizzleSql } = await import("drizzle-orm")`, then `agentInboxTable leftJoin projectsTable`.

### 4. Eval-results endpoint — `readDraftRaw(name)` instead of `readFile`
Reverted to `const raw = await readDraftRaw(name)` (wrong function, wrong variable).
Correct: `const raw = await readFile(path, "utf8")` where `path = join(process.cwd(), "scripts", "eval-results", "latest.json")`.

### 5. Audit-log route — spurious `_statusFilter` block injected mid-route
Merge injects:
```ts
const statusFilter = _statusFilter && ["open", "dismissed", "resolved"].includes(_statusFilter)
  ? _statusFilter : undefined;
```
inside the audit-log or domain-stats route body where `_statusFilter` doesn't exist.
Fix: delete the block entirely from any route that doesn't declare it.

### 6. Abuse-reports route — duplicate `statusFilter` declaration
Merge adds a second `const statusFilter = _statusFilter && ...` after the correct `const statusFilter = req.query.status as string | undefined`.
Fix: remove the duplicate; then wire `statusFilter` into the WHERE clause or lint catches "assigned but never used".

### 7. Body types narrowed to `{ reason?: string }` — lose `.enabled`, `.raw`, `.action`
Skills PATCH, drafts PATCH, abuse-reports resolve all get their body types reverted to `{ reason?: string }`.
Correct types: `{ reason?: string; enabled?: boolean }`, `{ reason?: string; raw?: string }`, `{ reason?: string; action?: string }`.

### 8. Stats endpoint — `bttResult` assigned inside `try {}` but not used; `res.json()` trapped inside try
Fix: after querying bttResult, map rows into `buildTokenTelemetryRows`, close `} catch { /* non-fatal */ }`, THEN call `res.json()` outside the try.

## Typical repair sequence

```bash
pnpm --filter @workspace/api-server run typecheck 2>&1 | grep "error TS"
pnpm run lint 2>&1 | grep -E "^\s.*error "
# fix all errors
git add -A && git commit -m "fix(admin): reconcile admin.ts after merge"
# restart push-to-github, then re-verify, then fire gate
```
