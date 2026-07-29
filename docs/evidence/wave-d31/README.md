# Wave D.3.1 — inline checkpoint navigation

## Root cause

The inline checkpoint action called `switchLeftPanel("history")`. That ID belongs to the
left-side activity history, not the preview-side `checkpoints` surface that owns Version
History and Restore.

The mismatch became a visible no-op when the Wave D.2 lazy/More behavior was active:
`moreTabsExpanded` was false, so the left-panel guard immediately reset any hidden
non-Chat tab back to `chat`. The existing `historyFocusVersionId` state also had no setter,
so checkpoint `#68` could never be selected or focused.

## Fix

- The action now opens the `checkpoints` workspace tab, expands the advanced tab strip,
  enables deferred advanced data, and closes the chat drawer on mobile.
- The clicked `versionId` is carried to `CheckpointsTab` as `focusCheckpointId`.
- When checkpoint data renders, the matching checkpoint is centered, receives DOM focus,
  `aria-current="true"`, and a restrained focused treatment.
- The report now uses the shared `InlineBuildResults` checkpoint action, removing the stale
  duplicate button implementation.

## Regression and restore verification

`checkpoint-history-navigation.test.tsx` renders the shipped inline checkpoint control and
the real `CheckpointsTab` behind the same navigation hook used by `[id].tsx`.

The test clicks checkpoint `#68` and asserts:

1. the active workspace tab becomes `checkpoints`;
2. the advanced surface is open;
3. the real Version History heading is visible;
4. checkpoint `#68` is scrolled, focused, and marked current;
5. Restore opens the real confirmation dialog; and
6. confirmation reaches the existing generated restore mutation with
   `{ id: 44, checkpointId: 68 }`.

The headed production-shaped browser run used the real components and generated API hooks,
with only the project/checkpoint HTTP responses bounded locally. It completed the full
interaction in both themes:

- inline checkpoint click;
- focused checkpoint `#68`;
- plain-language restore confirmation;
- `POST /api/projects/44/checkpoints/68/restore`; and
- success state confirming the forward checkpoint (`#69`) preserved the current version.

## Visual evidence

| Theme | Before: click stayed on Chat             | After: History focused               | Restore confirmation              | Restore complete                   |
| ----- | ---------------------------------------- | ------------------------------------ | --------------------------------- | ---------------------------------- |
| Dark  | `before-dark-checkpoint-click-noop.png`  | `after-dark-history-focused-68.png`  | `after-dark-restore-confirm.png`  | `after-dark-restore-complete.png`  |
| Light | `before-light-checkpoint-click-noop.png` | `after-light-history-focused-68.png` | `after-light-restore-confirm.png` | `after-light-restore-complete.png` |

## Verification results

- Focused regression + inline result tests: 5 passed.
- NabuFlow/frontend suite: 77 files, 919 tests passed.
- Full frontend invocation: all 919 registered tests passed; the unchanged Windows-only Ora
  sidebar suite still fails during import on `file:///logo.png` before registering tests.
- `pnpm typecheck:libs`: passed.
- `pnpm --filter @workspace/mustaflow typecheck`: passed.
- ESLint on changed TypeScript/TSX files with zero warnings: passed.
