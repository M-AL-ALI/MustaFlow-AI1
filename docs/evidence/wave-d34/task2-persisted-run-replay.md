# Wave D.3.4 Task 2 — persisted run replay

## Root cause

The live `QATapeInline` and completed `PersistedRunReplay` share the generated
`getListTaskEventsQueryKey(projectId, taskId)` query key.

During a build, the QA observer can fetch an early partial task-event snapshot. When the
completion message replaces the live run with `PersistedRunReplay`, that component previously
set `staleTime: Infinity`. React Query therefore treated the early cache entry—sometimes one
event—as complete and did not fetch authoritative history. That produced
`1 step · expand to replay`.

There was a second parity problem: persisted replay counted every raw event that could map to a
row, before the same dedupe and bounded-window helpers used by the live UI. That count could
diverge in the other direction from what the user actually saw live.

## Fix

- Completed replay now uses `refetchOnMount: "always"` on the existing task-events query. It
  replaces any partial live cache entry with the endpoint's authoritative ordered history.
- `buildRunReplayModel` now counts the union of the retained activity, narration, and QA event
  ids after the same dedupe/windowing rules used live.
- No API, event, or backend change was made.

## Real production-traffic fixture

The regression loads the authoritative captured fixture:

`docs/evidence/wave-d33/production-task-140.sse.gz`

Raw facts asserted by the test:

- 74 SSE frames.
- First event `queued`; last event `completed`.
- Production task id `140`, project id `44`.
- Replay count: **25 steps**, not 1.
- Retained activity, narration, and QA rows remain in ascending event-id order.
- Expanding the completed run renders every retained activity label, narration line, and QA
  step in that same order.
- The completed replay query explicitly requests an authoritative refetch on mount.

## Verification

- `inline-run-group.test.tsx` + `persisted-run-replay.test.tsx`: 7/7 passed.
- The fixture test reads the gzip capture directly; no synthetic replacement was introduced.
