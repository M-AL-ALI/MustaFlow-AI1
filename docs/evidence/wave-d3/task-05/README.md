# Wave D.3 Task 5 — collapse on completion

## Behavior

- One `InlineRunGroup` owns each build's intermediate activity, narration, and QA tape.
- A live run mounts expanded and keeps every current step visible.
- The live-to-terminal transition automatically collapses the group.
- The completed header uses the quiet wording
  `12 steps · expand to replay`; opening it changes the action to
  `12 steps · collapse replay`.
- Final summary, result rows, and checkpoint action remain visible outside the replay,
  so collapsing intermediate work never hides the outcome or recovery action.

## Persistence

`PersistedRunReplay` reads the existing
`/api/projects/:projectId/tasks/:taskId/events` query. `buildRunReplayModel` orders the
stored events by id and rebuilds activity states, narration lines, and QA steps without
creating a new event or persistence contract. Both recent chat and Full History use this
same persisted replay, collapsed by default.

The replay count includes existing activity, narration, and `qa_step` event ids once
each. Heartbeats and other invisible transport events do not inflate the number.

## Evidence

- `light-collapsed.png`, `dark-collapsed.png`: completed run reduced to one replay line
  while final results/checkpoint stay visible.
- `light-expanded.png`, `dark-expanded.png`: the same completed run replayed inline.
- `light-collapse-replay.gif`, `dark-collapse-replay.gif`: live → auto-collapse →
  expand-to-replay transition.

The evidence harness imported the production group, activity, narration, QA, result,
and avatar components and the application stylesheet; it was removed before commit.

## Verification

- Focused Vitest: 18 tests passed across run grouping, state mapping, and QA.
- Tests prove ordered persisted reconstruction, live-to-terminal auto-collapse,
  collapsed-by-default history, and manual replay expansion.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
