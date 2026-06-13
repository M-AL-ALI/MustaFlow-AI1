---
name: DB pool idle connection drops & deploy "database diff" error
description: Why "Connection terminated unexpectedly" floods prod logs and why the deploy-time "Failed to check for database diff" is safe to bypass.
---

# Symptom

- Publish/deploy shows: **"Failed to check for database diff: SERVER unexpectedly disconnected"** (with Republish / Adjust settings / Run security scan).
- Production logs flood with `pg-boss internal error ... Connection terminated unexpectedly` / `Connection terminated due to connection timeout`, plus occasional `Authentication timed out` on app queries.

# Root cause

Managed/serverless Postgres + the network layer (NAT / load balancer / idle timeout) silently drop **idle** TCP connections. node-postgres only discovers the dead socket when it next reuses the client → "Connection terminated unexpectedly". The shared `@workspace/db` pool was created with `new Pool({ connectionString })` and **no** options — no `keepAlive`, default 10s idle timeout, `connectionTimeoutMillis` 0 (wait forever), and **no `pool.on('error')` listener** (an idle-client error with no listener can crash the Node process).

# The two facts that resolve confusion

1. **The deploy "database diff" check is a Replit PLATFORM step**, run by the deploy infrastructure's own DB connection — NOT the app's `@workspace/db` pool. Hardening the app pool does not change it. **Republish/retry is the unblock**; transient disconnects clear on retry.
2. **It is safe to bypass that diff check** because the app runs its own startup migrations on boot (`startup-migrations: all migrations completed successfully passed=109`). The app does not depend on Replit's deploy-time migration/diff step.

# Rule / how to apply

- Any shared `pg.Pool` here must set `keepAlive: true`, a finite `connectionTimeoutMillis`, a sane `idleTimeoutMillis`, an explicit clamped `max`, **and** a `pool.on('error')` handler. **Why:** without keepAlive the idle drops are guaranteed on this host; without the error listener a dropped idle client can crash the process.
- `lib/db` is a low-level lib with **no pino logger** (only `drizzle-orm`/`pg`/`zod`); its pool error handler intentionally uses `console.error` — do not try to import the api-server logger into a lib.
- **pg-boss keeps its OWN pool** (`new PgBoss(connectionString)` in `durable-queue.ts`); it already has an error handler and self-heals/reconnects, so its log noise is non-fatal. Hardening `lib/db` does NOT silence pg-boss. To reduce pg-boss noise you must pass keepalive/timeout options to pg-boss separately (verify v12 forwards pg pool opts first).
