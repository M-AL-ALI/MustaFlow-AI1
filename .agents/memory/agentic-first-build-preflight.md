---
name: Agentic first-build preflight bypass
description: New agentic projects fail the /healthz preflight check before any app exists; fix is isFirstBuild detection in jobs.ts
---

## Rule

New agentic projects (0 project_versions) must skip the `/healthz` container health check in `runAgenticPreflightGate`. Pass `effectiveContainerUrl = null` to `ensureContainerAwake` — null already skips the poll (see container.ts line ~730).

## Why

`ensureContainerAwake` polls `${containerUrl}/healthz`. On a brand-new container with no app deployed yet, there is no HTTP server listening, so the poll always times out and the preflight fails — permanently blocking `runAgentLoop` from ever starting.

## How to apply

In `jobs.ts` inside `runAgenticPreflightGate`:
1. Query `project_versions` count for the project
2. `isFirstBuild = count === 0`
3. `effectiveContainerUrl = isFirstBuild ? null : containerUrl`
4. Pass `effectiveContainerUrl` to `ensureContainerAwake`
5. Emit a "Starting fresh — waking your container for the first build…" narration when isFirstBuild

Emit "Agentic builder loop engaged." in `runAgentLoop` entry so the SSE stream confirms the loop started.

## Verified

Tasks 263 (project 79) and 264 (project 80) both successfully passed preflight for the first time and entered the agent loop, confirmed by the narration events in the SSE stream.
