# Wave D.3 Task 6 — calm error and recovery

## Existing-event recovery mapping

No recovery behavior or event schema changed.

| Existing event | Existing payload/message | Inline recovery phase |
| --- | --- | --- |
| `qa_step` | `data.phase: "repair"`, `status: "running"` | Try |
| `editing_files` | message beginning `Repairing ...` | Adapt |
| `qa_step` | `data.phase: "repair"`, `status: "passed"` | Observe (resolved) |
| `qa_step` | `data.phase: "repair"`, `status: "failed"` | Observe (needs action) |

`recoveryStepForEvent` reads those existing values, preserves event-id order, and
deduplicates replayed SSE events. Repair-phase QA rows are removed from the generic QA
list only when the dedicated recovery loop is present, preventing duplicate lines.

## Error treatment

- The bordered red error card and red assistant bubble are retired.
- `InlineBuilderError` starts with “I couldn't finish this step,” preserves the honest
  server detail describing what broke, and places each real recovery suggestion beside
  a `Try this` action.
- A failed bounded repair shows `Try another fix` beside the failed Observe step. In the
  workspace it sends the normal follow-up prompt through the existing builder send
  path.
- Stream connection errors use the same borderless Zero-message treatment and retain
  their existing sign-in/retry actions.
- Icons are color-neutral; failure is conveyed by wording and `AlertTriangle`, not a
  large red panel.

## Persistence

`PersistedRunReplay` reconstructs Try → Adapt → Observe from the existing stored task
events. Recent chat and Full History receive the same recovery loop and retry action.

## Evidence

- `light-adapt.png`, `dark-adapt.png`: a live Adapt step with restrained status.
- `light-failed.png`, `dark-failed.png`: failed Observe, exact failure detail, and both
  recovery actions without red card chrome.
- `light-recovery.gif`, `dark-recovery.gif`: Try → Adapt → Observe progression.

The temporary evidence harness imported the production recovery, error, and avatar
components with the application stylesheet; it was removed before commit.

## Verification

- Focused Vitest: 23 tests passed across recovery mapping/actions, error actions,
  persisted replay, state mapping, and QA.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
