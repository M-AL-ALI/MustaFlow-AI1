# Wave D.3 Task 2 — word-by-word streaming

## Contract mapping

- Build narration uses the existing task stream at
  `/api/projects/:projectId/tasks/:taskId/events/stream`. An event with
  `eventType: "narration"` and its existing `message` field is appended in event-id
  order. The newest message is revealed word by word; prior narration remains stable.
- Conversational replies continue to use the existing
  `/api/projects/:projectId/messages/stream` contract. Every `type: "token"` event
  appends its `content` directly to the live assistant response.
- Task-stream `eventType: "token"` remains the live code buffer. It is deliberately
  not presented as Zero narration.
- No event name, payload, endpoint, or persistence contract changed.

## Layout and motion

The renderer places an invisible copy of the complete newest narration line in normal
layout while the visible copy streams over it. The thread therefore reserves its final
height immediately and does not shift as words appear. Reduced-motion users receive
the complete line without the timed reveal.

## Evidence

- `light-streaming.png` and `dark-streaming.png`: an actual partially revealed line.
- `light-complete.png` and `dark-complete.png`: the same real component at rest.
- `light-streaming.gif` and `dark-streaming.gif`: short captures of the incremental
  reveal in each theme.

The evidence harness imported the production `InlineNarrationStream` and application
stylesheet. The temporary harness was removed before commit.

## Verification

- Focused Vitest: 3 tests passed.
- NabuFlow frontend TypeScript: passed.
- ESLint on the changed TypeScript/TSX files: passed.
