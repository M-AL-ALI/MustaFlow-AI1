# Wave D.3 Task 3 — inline activity states

## Source-backed mapping

The builder consumes existing task events; it does not invent a parallel state model.

| Existing event source    | Existing values                                                                                                                                                  | Inline state                           | Lucide icon           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------- |
| Agent-loop lifecycle     | `queued`, `started`, `thinking`, `analyzing_request`                                                                                                             | Thinking                               | `Loader`              |
| Context/file reads       | `loading_context`, `reading_files`                                                                                                                               | Reading                                | `Eye`                 |
| Planner                  | `planning`, `planning_changes`, `generating_blueprint`                                                                                                           | Planning                               | `ListChecks`          |
| File generation          | `generating_code`, `editing_files`, `file_diff`, `saving_files`, `project_files_changed`                                                                         | Writing code                           | `Code`                |
| Existing validators/QA   | `validating_output`, `testing`, `qa_step`, `qa_done`, `command_output`, `check_result`, `typecheck_result`, `build_result`, `test_result`, `health_check_result` | Checking                               | `Eye`                 |
| Existing version event   | `saving_version`                                                                                                                                                 | Saving a checkpoint → Checkpoint saved | `GitCommit` → `Check` |
| Existing preview events  | `updating_preview`, `preview_ready`                                                                                                                              | Refreshing preview → Preview ready     | `Globe` → `Check`     |
| Existing terminal events | `finalized`, `completed`, `cancelled`                                                                                                                            | Done / Stopped                         | `Check`               |
| Existing failure events  | `failed`, `aborted`, `preflight_error`, `container_unavailable`, `qa_timeout`                                                                                    | Plain-language attention state         | `AlertTriangle`       |

`narration` is intentionally excluded from the activity mapper because Task 2 renders
its message as streamed prose. Unknown event types are ignored.

Brainstorming and Publishing are not agent-loop task states. Their `Lightbulb` and
`Rocket` variants are driven by those existing UI operations; Task 4 connects their
real pending states to the same inline treatment while moving those surfaces into the
thread.

## Resolution behavior

Only the latest non-terminal row pulses. When the next real event arrives, the prior
row changes to a static `Check` and its resolved wording. Terminal completion and
failure rows are static immediately. Consecutive duplicate phases replace each other
instead of creating visual noise.

## Zero identity

`ZeroAvatar` reuses the existing NabuFlow agent mark and now appears on live task
activity, streamed replies, typing state, recent assistant messages, and Full History
metadata. Full History also says “Zero” instead of the generic “AI”.

## Evidence

- `light-active.png`, `dark-active.png`: resolved checks plus one pulsing current state.
- `light-completed.png`, `dark-completed.png`: the same run after the terminal event.
- `light-activity.gif`, `dark-activity.gif`: the emitted-state sequence transitioning
  from thinking through completion.

The temporary harness imported the production state mapper, activity component, avatar,
and application stylesheet; it was removed before commit.

## Verification

- Focused Vitest: 15 tests passed across activity and narration.
- NabuFlow frontend TypeScript: passed.
- ESLint on all changed TypeScript/TSX files: passed.
