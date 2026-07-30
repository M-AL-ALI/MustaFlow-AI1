# Wave D.3.7 — step-count integrity

## Source captures

- `production-task-164.sse.jsonl`
  - Real production task: `164`
  - Raw SSE frames: `199`
  - SHA-256: `e96887404ccac2184f164cac2e6d26d2977933d36f4429c4529842d1124f6234`
- `../wave-d33/production-task-140.sse.gz`
  - Real production task: `140`
  - Raw SSE frames: `74`
  - SHA-256: `b6113f0ad80f9caea42e4e2d7a1802cc83917b822fe29d702c38eeb1d7d18aa8`

No synthetic event sequence is used for the D.3.7 counting regression.

## Baseline reproduction

Before the implementation, the task-164 regression failed with:

```text
expected 27 to be 28
```

The final retained activity/narration windows lost one id when `qa_done` arrived, reproducing
run-7 item 5.

## Fix verification

`run-step-count.test.ts` feeds the raw task-164 frames through the live cumulative set in
capture order, then rebuilds the same set from persisted events and from a cloned reload
snapshot. All three counts are `28`, and the live sequence is asserted to be monotonic.

The same helper processes task 140 as `25`, preserving the D.3.4 regression.

The activity and narration render arrays remain independently capped at 12 rows.

## Local verification

- D.3.7 scoped regression: 3 files, 9 tests passed.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed with zero warnings.
- Prettier check on changed source, tests, and this evidence note: passed.
- Full NabuFlow frontend suite: 82 files and 950 tests passed; the unrelated existing
  Ora sidebar suite failed during collection on its `file:///logo.png` fixture and
  reproduces unchanged from the clean parent worktree. No Ora file was modified.
