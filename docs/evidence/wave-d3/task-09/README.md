# Wave D.3 Task 9 — refresh rehydration and run progress

## Refresh path

No backend or event contract changed.

1. `GET /api/projects/:projectId/tasks` remains the source of task truth.
2. On mount, `selectRehydratableTaskId` selects only a real in-flight status:
   `planning`, `building`, `testing`, or `needs_approval`. A newer queued task and
   terminal `completed` / `failed` / `canceled` / `cancelled` rows are not mistaken for
   the active run.
3. The existing
   `GET /api/projects/:projectId/tasks/:taskId/events/stream` endpoint subscribes before
   replaying all persisted task events, then flushes buffered live events without an
   event-id gap.
4. The replay reconstructs narration, activity, QA, recovery, prompts, calm phase, and
   exact loop progress through the same handlers used for new live events.
5. The persisted task status holds the workspace busy state after refresh, when the
   originating mutation no longer exists. A replayed terminal event immediately marks
   the inline group terminal, removes Stop, collapses the run, and refreshes task/message
   queries.

## Whole-run progress

The restrained `step N of M` label reads the existing `loop:step` JSON payload emitted
by the agent loop (`stepIndex`, `stepCap`). It is not a guessed percentage or a new
state. The existing event remains metadata-only and is not duplicated as an activity
row.

## Evidence

- `light-before-refresh.png`, `dark-before-refresh.png`: task #12 is the active build,
  with five stored events and exact `step 3 of 25`.
- `light-after-refresh.png`, `dark-after-refresh.png`: a full browser reload reaches
  `Refresh pass 2`, selects the same task #12 despite newer queued/terminal rows, restores
  the same five events, and preserves `step 3 of 25`.
- `light-next-event.png`, `dark-next-event.png`: the rehydrated group accepts the next
  existing event and advances to `step 4 of 25`.
- `light-refresh-rehydrate.gif`, `dark-refresh-rehydrate.gif`: short
  before-refresh → after-refresh → continued-stream recordings.

The evidence harness imported the production task selector, loop-progress parser,
run-group, replay model, activity/narration renderers, and Zero avatar with the
application stylesheet. It was removed before commit.

## Verification

- Focused Vitest: 9 tests passed, including task selection, terminal/queued rejection,
  exact progress parsing, malformed-event rejection, progress rendering, and completed
  run collapse.
- Browser assertions repeated in both themes: refresh pass `1 → 2`, task `#12 → #12`,
  progress `3/25 → 3/25`, then live continuation `4/25`.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
