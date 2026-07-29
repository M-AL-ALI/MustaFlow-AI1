# Wave D.3 Task 8 — smart auto-scroll

## Behavior

- The recent thread follows message, task-event, QA, narration, recovery, agent-prompt,
  brainstorm, publishing, pending-send, and conversational `streamingText` updates
  while the user remains at the bottom.
- Any upward movement pauses following immediately, including a one-pixel move. A
  growing token or event stream therefore cannot pull the user away from what they are
  reading.
- Following resumes only when the user reaches the true bottom (16 px tolerance) or
  activates the `Jump to latest` / `New activity` pill.
- The pill explicitly restores the follow ref, scroll position, and visible state in the
  same action; it does not depend on a later browser `scroll` event.
- Full History uses the same policy. New persisted messages no longer force a reader
  back to the bottom while they inspect an older run.
- Stream-driven scrolling is scheduled on `requestAnimationFrame` and checks the follow
  lock again inside the frame, avoiding stale scheduled jumps and layout jank.

## Evidence

- `light-following.png`, `dark-following.png`: the live thread follows the newest row.
- `light-paused.png`, `dark-paused.png`: after an upward user scroll, two new streamed
  updates arrive while the exact `scrollTop` remains unchanged (`0 → 0` in both theme
  passes); the `New activity` pill appears.
- `light-latest.png`, `dark-latest.png`: activating the pill returns to rows 13–14 and
  restores follow mode.
- `light-smart-follow.gif`, `dark-smart-follow.gif`: short recordings of
  follow → pause with two updates → jump to latest.

The evidence harness imported the production Zero avatar, follow-state helpers, and
`JumpToLatestButton` with the application stylesheet. It was removed before commit.

## Verification

- Focused Vitest: 4 tests passed for immediate upward-scroll pause, bottom-only resume,
  direct scroll restoration, and the pill action.
- Browser interaction assertion, repeated in both themes: paused scroll position stayed
  unchanged across two appended stream updates; the pill disappeared after returning.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
