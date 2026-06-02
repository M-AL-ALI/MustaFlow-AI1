---
name: flyFetch per-request timeout
description: flyFetch must carry an explicit AbortSignal.timeout; without it exec POSTs hang when a Fly machine is in a transient wake state, tripping the stuck-run scheduler.
---

## Rule
`flyFetch()` in `container.ts` must pass `AbortSignal.timeout(timeoutMs)` to every
`fetch()` call. Default: 30 s for Fly management-API calls. Exec POST calls must
use 360_000 ms (6 min — 60 s above Fly's max exec timeout of 300 s).

## Why
When a Fly machine is stopped or mid-wake, the exec POST TCP connection can hang
indefinitely — `fetch()` has no built-in timeout. The agent-loop is stuck inside
`writeFileToContainer` → `execInContainer` → `flyFetch`, no heartbeat is written,
and the stuck-run scheduler kills the task after 5 (now 8) minutes even though the
job is still running in-memory.

## How to apply
- `flyFetch(path, init, timeoutMs?)` — always pass 360_000 for exec calls:
  ```ts
  flyFetch(`/apps/${FLY_APP}/machines/${machineId}/exec`, { method:"POST", body }, 360_000)
  ```
- Default (30 s) covers all other Fly API calls (start, stop, status, PATCH).
- Also write a heartbeat to `agent_tasks.last_heartbeat_at` at the START of
  `runAgenticPreflightGate` so the stuck-run clock resets before the wake loop.
- stuck-run HEARTBEAT_TIMEOUT_MS is 8 min (not 5) to allow for slow Fly cold-starts.
