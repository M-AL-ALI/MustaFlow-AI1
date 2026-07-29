# Wave D.3.5 — checkpoint action regression

## Root cause

### Why run 5 could no-op after working in run 4

The Wave D.3.4 diff did not remove or omit the checkpoint callback. Its only relevant
frontend change was `PersistedRunReplay` adding `refetchOnMount: "always"` so a freshly
completed run replaces the partial live event cache with authoritative history.

The checkpoint control was still a click-only button. During the live → completed
transition, the authoritative refetch can replace the completed report node after
pointer-down but before the browser emits `click`. The detached button never receives
React's `onClick`, so `openCheckpointHistory` is never called. There was also no pending
navigation intent at page level to survive or recover from that replacement.

The new page-composition regression test models that exact sequence:

1. render the real page `ReportCard` beside `PersistedRunReplay`;
2. confirm the replay hook requests `refetchOnMount: "always"`;
3. pointer-down on the checkpoint action;
4. replace the report with the authoritative revision; and
5. pointer-up on the replacement.

Before the fix, the new test failed with `Expected: checkpoints; Received: preview`.
After the fix, navigation starts on primary pointer-down, keyboard activation still uses
click, and page-level navigation remains pending until `CheckpointsTab` confirms that the
requested checkpoint was focused.

The saved run-5 evidence also corrects the prior report: the continuous-session dark click
was the failing transition case, but the post-reload light click did open Version History
and rendered 18 Restore actions. A clean production retry of persisted checkpoint `#80`
also opened Version History. The persisted path was not broken; the live replacement race
was.

### Why the D.3.1 regression test stayed green

The D.3.1 harness mounted `InlineBuildResults` directly with a stable callback and the
navigation hook. It did not mount:

- the page-level `ReportCard`;
- the preceding `PersistedRunReplay`;
- the authoritative `refetchOnMount` lifecycle;
- the live message/report replacement; or
- `ChatHistory`'s separate Full History report renderer.

It therefore proved the hook worked when called, but never exercised the production path
that could lose the click before the hook ran. Full History also rendered a non-interactive
duplicate line with the old “roll back any time” wording, so that path was entirely outside
the original test.

## Fix

- Added one shared `CheckpointHistoryAction` used by live results, persisted results, and
  Full History.
- The action opens on primary pointer-down so report replacement cannot swallow it, while
  retaining click activation for keyboard users and de-duplicating the following pointer
  click.
- The callback now receives the checkpoint ID from the shared action instead of closing
  over a particular report render.
- `useCheckpointHistoryNavigation` retains a pending checkpoint request and reasserts the
  `checkpoints` tab until the lazy Version History surface confirms focus.
- `CheckpointsTab` acknowledges focus only after the target was scrolled and focused.
- Full History now threads the same page callback through `ChatHistory` and uses the same
  shared action and wording: **“Checkpoint saved — restore any time.”**

## Test gap closed

`checkpoint-history-navigation.test.tsx` now covers:

1. a freshly completed page report replaced during the authoritative refetch;
2. a stable persisted/reloaded page report;
3. the real Full History `ChatHistory` renderer;
4. the focused Version History surface; and
5. the existing restore confirmation and mutation.

The focused suite passes 8 tests across the navigation, inline-result, and captured
production replay files.

## Visual and interaction evidence

| Evidence                                                               | File                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Run-5 live-session no-op, dark                                         | `before-live-session-checkpoint-noop-dark.png` |
| Production Full History duplicate old wording, dark                    | `before-production-full-history-dark.png`      |
| Post-refetch shared action opens focused checkpoint, dark              | `after-post-refetch-history-focused-dark.png`  |
| Post-refetch shared action opens focused checkpoint, light             | `after-post-refetch-history-focused-light.png` |
| Restore confirmation completed and forward checkpoint preserved, light | `after-restore-forward-checkpoint-light.png`   |

The headed production-shaped verification used the real shared action, navigation hook,
and `CheckpointsTab`. It replaced the report revision before activation, opened checkpoint
`#80`, focused it in both themes, then completed the existing restore confirmation path.
