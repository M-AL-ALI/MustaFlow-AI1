# Wave D.3 Task 11 — working anchor and mode density

## Persistent working anchor

The active run now starts with one subtle, persistent line:

`Zero is working · <current phase>`

Its icon and phase come from the latest existing mapped task event in
`InlineActivityStream`; it does not create a new state. Before the first event it uses
the existing queued fallback `Getting started`. The anchor stays above the collapsible
run details, so it remains visible even at Lite density. When the replayed terminal
event arrives, it swaps to static `Zero finished` while the group follows the Task 5
completion-collapse behavior.

## Density by mode

The same arrays remain in memory and persistence for every mode. Only the default live
window changes:

| Mode  | Density  | Default live treatment                                                     |
| ----- | -------- | -------------------------------------------------------------------------- |
| Lite  | Minimal  | Group closed; opening shows the current activity/narration row             |
| Eco   | Standard | Open; six most recent rows                                                 |
| Power | Standard | Open; six most recent rows                                                 |
| Pro   | Detailed | Open; full 12-row live window and exact `loop:step` progress in the anchor |

Completed replays still start collapsed in every mode, keeping history scannable.
Expanding a persisted replay uses detailed history, so the stored story is never lost.

## Evidence

- `light-density.png`, `dark-density.png`: all four modes render the same eight-event
  source with one persistent current-phase anchor. Initial DOM counts were:
  Lite `0` rows / collapsed, Eco `6`, Power `6`, Pro `8`, with Pro anchor progress
  `step 8 of 25`.
- `light-lite-expanded.png`, `dark-lite-expanded.png`: Lite expands on demand to its
  one current row while the other modes retain their defaults.
- `light-density-interaction.gif`, `dark-density-interaction.gif`: short recordings of
  the Lite disclosure opening beside the unchanged Eco/Power/Pro treatments.

The evidence harness imported the production density mapper, working anchor, run group,
activity stream, and narration stream with the application stylesheet. It was removed
before commit.

## Verification

- Focused Vitest: 27 tests passed across density mapping, non-mutating visibility,
  working-anchor phase/progress, live default expansion, activity, and narration.
- Browser assertions repeated in both themes confirmed the row counts, expansion state,
  persistent phase text, and Pro-only anchor progress.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
