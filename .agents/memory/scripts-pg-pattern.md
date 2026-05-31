---
name: Scripts package pg pattern
description: Migration scripts in scripts/src/ must use pool from @workspace/db, not pg directly.
---

## Rule
Migration scripts in `scripts/src/` must import the shared pool from `@workspace/db`:

```typescript
import { pool } from "@workspace/db";
```

Never `import { Pool } from "pg"` — the `scripts` package does not have `pg` as a direct dependency.

**Why:** The `scripts/package.json` only declares `@workspace/db` as a dependency (not `pg`). Using raw `pg` causes a TS2307 "cannot find module" error during `scripts typecheck`.

**How to apply:** Every new `scripts/src/migrate-*.ts` file should use `pool.connect()` from `@workspace/db`. The pattern is identical to `migrate-vault.ts` and all other vault migration scripts.
