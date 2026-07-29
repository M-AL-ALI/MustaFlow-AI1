# Wave D Task 4 - Version History restore evidence

Date: 2026-07-28

## Before and after

- Before, the previous checkpoint surface:
  [`version-history-before.png`](version-history-before.png)
- Plain-language confirmation:
  [`restore-confirmation.png`](restore-confirmation.png)
- After restore, with both new forward checkpoints:
  [`version-history-after-restore.png`](version-history-after-restore.png)
- Preview selected again after the restore:
  [`restore-preview-resynced.png`](restore-preview-resynced.png)

The images were captured in headed Chrome against the local frontend with a deterministic,
production-shaped fixture. The temporary fixture and auth adapter are excluded from the feature
commit. The fixture preview itself is cross-origin blocked in the screenshot; the client still
returned to the Preview tab and issued its refresh.

## Restore interaction

The confirmation copy is:

`Take your app back to how it was at 1:42 PM? Your current version stays saved.`

The headed interaction restored checkpoint `57` for project `45` through:

`POST /api/projects/45/checkpoints/57/restore`

The response was:

```json
{
  "checkpointId": 57,
  "label": "Focus Flow ready",
  "restoredFiles": 3,
  "truncatedMessages": 0,
  "forwardCheckpointId": 59,
  "restoredCheckpointId": 60,
  "dbSnapshotRestored": false,
  "dbSnapshotError": null
}
```

The refreshed list showed four versions, newest first:

1. `60` - `Restored "Focus Flow ready"`
2. `59` - `Before restoring "Focus Flow ready"`
3. `58` - `Current subtitle update`
4. `57` - `Focus Flow ready`

The chat received:

`Restored "Focus Flow ready" with 3 files. Your previous version is still saved.`

## Route-level round-trip

The API test sends a real Supertest HTTP request through the Express restore route while using a
deterministic in-memory persistence adapter:

- starting checkpoint IDs: `[7, 8]`;
- starting files: current `src/App.tsx` plus `src/New.ts`;
- starting chat messages: `2`;
- request: `POST /projects/45/checkpoints/7/restore`;
- response: safety checkpoint `100`, restored checkpoint `101`, one restored file, zero truncated
  messages;
- ending checkpoint IDs: `[7, 8, 100, 101]`;
- ending files: the selected checkpoint's earlier `src/App.tsx`;
- ending chat: the original two messages preserved plus one restore marker;
- preview event: selected file payload, removed path `src/New.ts`, operation `rollback`;
- database capture: attempted for both checkpoint `100` and checkpoint `101`.

This exercises the production route transaction and response contract without changing production
data.

## Forward-only behavior

The server saves the current files before applying the selected version, appends another checkpoint
for the restored state, and never deletes an existing checkpoint or chat message. It publishes the
existing `project_files_changed` contract so a connected preview resyncs, and the frontend
invalidates checkpoints, chat, files, versions, and project queries before returning to Preview.

## Checks

- Frontend TypeScript: pass.
- API TypeScript: pass.
- Shared-library TypeScript: pass.
- API route test: 1 passed.
- Frontend copy/model tests: 2 passed.
- OpenAPI codegen was run twice; SHA-256 values for every changed generated file were identical on
  the second run.
