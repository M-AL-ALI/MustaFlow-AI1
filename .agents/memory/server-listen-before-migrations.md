---
name: server.listen() must bind before startup migrations
description: Why binding the HTTP port before runStartupMigrations() is essential to avoid connection-refused downtime during deploys.
---

## The rule

Call `server.listen(port, ...)` BEFORE `runStartupMigrations()` and `runContainerSelfCheck()`. Never gate the port bind on async startup steps.

## Why

Reverse proxy + external uptime monitors never stop polling. When a deploy restarts the process:
1. Old process is killed → port goes dark
2. New process starts → migrations run (can take 10–30 s) → port NOT yet bound
3. Proxy can't connect → returns 502/500 to all callers
4. Uptime monitor logs every poll during that window as "downtime"

This caused a reported 88% uptime (12 s × many polls = visible outage) on the Jun 18, 2026 deploy.

## How to apply

```ts
// Bind first — /api/healthz needs no DB, platform startup check passes immediately.
server.listen(port, callback);

// Migrations and self-checks run AFTER binding.
void runStartupMigrations()
  .catch(logAndContinue)
  .then(() => runContainerSelfCheck().catch(logAndContinue))
  .finally(() => logger.info("startup complete"));
```

Application routes that hit the DB before migrations finish will 500 gracefully — that's acceptable because migrations are idempotent and typically a no-op when schema is current.

## Symptoms confirming this is the bug

- Deployment logs show: `healthcheck /u returned status 500` and `healthcheck /api returned status 500` in a burst at startup
- After the burst, those same paths return 404 (server is up, no route matches)
- The outage window corresponds exactly to the migration duration
