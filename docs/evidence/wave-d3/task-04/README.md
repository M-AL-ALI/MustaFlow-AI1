# Wave D.3 Task 4 — everything inline

## Existing flows retained

- **Checkpoints:** the live `saving_version` task event resolves to “Checkpoint saved”.
  Completed reports use their existing `versionId` and keep the real “restore any time”
  action that opens Version History. No checkpoint or restore contract changed.
- **Publishing:** the existing Publishing tab operations (`publish`, staging publish,
  promote, and deploy) report their real pending/success/failure state to the parent
  thread. The existing `suggest_deploy` prompt uses the same callback. No publish
  request, gate, or endpoint changed.
- **Questions:** existing `agent_prompt` events still render the real choice, boolean,
  text, secret, and publish controls, and answers still POST to
  `/api/projects/:projectId/tasks/:taskId/prompts/:promptId/respond`. The presentation
  is now an inline Zero message without amber card chrome.
- **New ideas:** report suggestions render through `InlineIdeas`. It preserves Build,
  Edit & Build, Save, and Dismiss. Both this inline surface and the Ideas tab read the
  same `/api/projects/:projectId/suggestions` records.
- **Ideas synchronization:** every accept/save/dismiss mutation invalidates the shared
  endpoint-prefix query key (`getListSuggestionsQueryKey(projectId)`), which refreshes
  both task-scoped inline queries and the unscoped Ideas-tab query. No local duplicate
  store was introduced.
- **QA tape:** the existing `qa_step` task events and persisted task-event query feed
  `QATapeStepsInline`. Live and reload behavior still share that one channel. Status
  icons, ordered lines, and bounded screenshots now use the same borderless thread
  treatment.
- **Brainstorming:** the existing brainstorm chat/resolve mutation pending state is
  mirrored as the `Lightbulb` activity row; completion resolves to a static check.

## Evidence

- `light-inline-surfaces.png`, `dark-inline-surfaces.png`: question and answer controls,
  QA lines and bounded screenshot, actionable ideas, report details, and checkpoint.
- `light-qa-and-ideas.png`, `dark-qa-and-ideas.png`: the publishing activity phase in
  the same complete inline flow.
- `light-inline-flow.gif`, `dark-inline-flow.gif`: the real activity component moving
  from Brainstorming to Publishing to Published while the other inline surfaces remain
  stable.

The temporary evidence harness imported the production components and application
stylesheet; it was removed before commit.

## Verification

- Focused Vitest: 18 tests passed across activity mapping, idea actions, QA live/reload,
  and brainstorm contract coverage.
- The `InlineIdeas` interaction test exercises Save, Build, Edit & Build, and Dismiss.
- NabuFlow frontend TypeScript: passed.
- ESLint on all changed TypeScript/TSX files: passed.
