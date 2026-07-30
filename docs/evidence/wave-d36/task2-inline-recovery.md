# Wave D.3.6 Task 2 — inline recovery across tasks

## Captured production reality

The checked-in fixture is a bounded, ordered slice of the captured project-44
traffic for tasks 147 and 148. Production encoded command details as JSON in
the event `message`; `data` was null.

| Signal            | Task 147/148 capture                                          | Previous D.3 expectation            |
| ----------------- | ------------------------------------------------------------- | ----------------------------------- |
| Failed check      | `command_output` final, `exitCode: 1`                         | No mapping                          |
| Run ending        | `completed`, task row `completionKind: step_cap`              | Error chat payload                  |
| In-run repair     | No `qa_step` with `phase: repair`                             | `qa_step.phase=repair`              |
| Adapt event       | `editing_files`: `Updating src/App.tsx`                       | Message beginning `Repairing`       |
| Background fix    | Task 148 ordinary `queued`/`narration`/`reading_files` events | No cross-task mapping               |
| Parent-child link | Refreshed task-147 `report.architectReview.autoFixTaskId=148` | Previously stripped at API boundary |

This confirms the real path:

```text
command_output exit 1
→ task 147 reaches step_cap
→ no bounded in-run self-heal because no steps remain
→ architect review queues task 148
→ refreshed task-147 report links autoFixTaskId=148
```

## Rendering

The inline treatment now maps the real signals to:

```text
A check needs attention.
TypeScript check exited with code 1.
This run used all its available steps before it could repair the issue.

Recovery
Try      Ran the TypeScript check.
Observe  TypeScript check exited with code 1.
Adapt    Zero is fixing the TypeScript check in the background.
```

The linked task status updates the Adapt line:

- queued: `A fix for the TypeScript check is queued.`
- running: `Zero is fixing the TypeScript check in the background.`
- completed: `The TypeScript check fix completed.`
- failed/canceled/discarded: `The TypeScript check fix could not finish.`

`Open fix run` focuses the linked task's run group. The active linked task is
polled while it is running. The existing `qa_step.phase=repair` and
`editing_files: Repairing...` mappings remain unchanged for genuine in-run
self-heal.

Association is deliberately strict: only
`source.report.architectReview.autoFixTaskId` is accepted. The captured
`Architect Auto-fix:` title, timestamps, background kind, and prompt are never
used to infer a relationship.

When a `task-queued` chat signal arrives, the workspace refetches the task list
once so the source report's persisted link becomes visible immediately.

## Visual evidence

- [Light mode — linked recovery running](./recovery-story-light.png)
- [Dark mode — linked recovery completed](./recovery-story-dark.png)

Both captures use the real task-147 failure fixture and the linked task-148 row.
The treatment uses inherited neutral colors, no red panel, and no card border.

## Regression coverage

The frontend regression suite asserts:

1. real command failures are parsed from `message`;
2. task 147 contains no in-run repair events;
3. task 148 resolves only through `autoFixTaskId`;
4. the real `task-queued` signal causes one source-report refetch;
5. step-cap honesty, Try → Observe → Adapt ordering, calm styling, and the jump
   action render correctly;
6. task-148 completion is reflected back on task 147.

```text
inline-run-recovery + existing recovery/run/error/replay suites:
5 files passed
17 tests passed

Complete frontend suite excluding the unrelated Ora sidebar fixture:
81 files passed
948 tests passed

Frontend TypeScript: passed
API TypeScript: passed
Generated-library TypeScript: passed
ESLint (changed builder/API files): passed
Vite production bundle: built successfully (postbuild dynamic prerender then
stopped because this checkout has no DATABASE_URL)
```
