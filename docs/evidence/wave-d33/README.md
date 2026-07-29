# Wave D.3.3 evidence

## Task 1 — production event capture

- Site/account: production, `mus_192@yahoo.com`
- Project: `44`
- Task: `140`
- Request: `POST /api/projects/44/messages`
- Request body:

  ```json
  {
    "content": "D3.3 event capture: change the small subtitle ending punctuation to a question mark, preserve everything else, and run the project TypeScript check.",
    "agentMode": "power",
    "planMode": false,
    "deepReasoning": false,
    "background": false,
    "agentIdentity": "main",
    "agentIntent": "build",
    "idempotencyKey": "wave-d33-capture-<browser timestamp>"
  }
  ```

- Task row: `kind=main`, `status=completed`, `completionKind=finalized`
- Production timestamps:
  - created `2026-07-29T15:21:46.029Z`
  - started `2026-07-29T15:21:46.077Z`
  - completed `2026-07-29T15:24:11.392Z`
- SSE: `GET /api/projects/44/tasks/140/events/stream`, HTTP `200`,
  `74` complete frames, `53,275` UTF-8 bytes.
- Raw capture: `production-task-140.sse.gz`. It is a byte-for-byte gzip of the
  SSE response body. Decode with `gzip -dc production-task-140.sse.gz`.
- Raw SHA-256:
  `3c7d514cbe1b75e45f6613cb7a296ce0a6e64458effea8309cf6fd452a90a69b`
- Parsed audit: `production-task-140-inventory.json`.

### Answers from the raw stream

1. **Are narration events emitted?** Yes. Production emitted `21` persisted
   `narration` events. Examples include “Let me read the current project files
   before making any changes.”, “Applying your changes to the React + Vite
   project now.”, and “Agentic builder loop engaged.”
2. **Which real events were ignored or mis-keyed?** The live renderer understood
   explicit `narration`, common file/check states, QA, and terminal events. It
   ignored structured `loop:step`, `tool_call`, `review_context`, and
   `check_deferred` as user-facing state/narrative inputs. More importantly, the
   EventSource was never attached for affected sends because the new task was
   not promoted into `activeTaskId`.
3. **Why did the anchor/run group disappear?** The synchronous message POST does
   not return the task id until the build finishes. Polling tried to discover it
   with a browser-time versus server-time comparison; the production clocks did
   not match, so the real row was filtered out. A one-use rehydration guard could
   rescue the first run only. The separately computed `pendingFeedTaskId` was
   stored only for Stop and never promoted into the SSE-backed run. With no
   `activeTaskId`, the render condition unmounted the anchor and run group.

### Exact event-type order

```text
01 queued
02 narration
03 reading_files
04 reading_files
05 narration
06 generating_code
07 narration
08 check_deferred
09 loop:step
10 tool_call
11 loop:step
12 file_diff
13 generating_code
14 loop:step
15 file_diff
16 generating_code
17 loop:step
18 narration
19 loop:step
20 command_output
21 narration
22 command_output
23 narration
24 narration
25 loop:step
26 command_output
27 narration
28 command_output
29 narration
30 narration
31 loop:step
32 command_output
33 narration
34 command_output
35 narration
36 narration
37 loop:step
38 narration
39 loop:step
40 command_output
41 narration
42 command_output
43 narration
44 narration
45 loop:step
46 review_context
47 tool_call
48 loop:step
49 tool_call
50 loop:step
51 tool_call
52 loop:step
53 tool_call
54 loop:step
55 tool_call
56 loop:step
57 narration
58 check_result
59 narration
60 narration
61 editing_files
62 editing_files
63 narration
64 saving_version
65 project_files_changed
66 updating_preview
67 qa_step
68 qa_step
69 qa_step
70 qa_step
71 qa_step
72 page_map_updated
73 qa_done
74 completed
```

### Counts

| Event type              | Count |
| ----------------------- | ----: |
| `narration`             |    21 |
| `loop:step`             |    15 |
| `command_output`        |     8 |
| `tool_call`             |     6 |
| `qa_step`               |     5 |
| `generating_code`       |     3 |
| `reading_files`         |     2 |
| `file_diff`             |     2 |
| `editing_files`         |     2 |
| `queued`                |     1 |
| `check_deferred`        |     1 |
| `review_context`        |     1 |
| `check_result`          |     1 |
| `saving_version`        |     1 |
| `project_files_changed` |     1 |
| `updating_preview`      |     1 |
| `page_map_updated`      |     1 |
| `qa_done`               |     1 |
| `completed`             |     1 |

For two or three payload samples per repeated type, and every available payload
for singleton types, see `production-task-140-inventory.json`. The gzip remains
the authoritative raw record.

## Fixture comparison

The Wave D.3 lab tests mounted the activity/narration/run-group renderers with an
already-known active task and short synthetic arrays such as
`reading_files → narration → generating_code → completed`. They correctly proved
word reveal, icon transitions, replay, and density, but did not exercise the
production lifecycle:

```text
synchronous POST pending
  → task row appears in polling
  → frontend discovers task id
  → EventSource attaches
  → persisted history replays, then live frames continue
```

The D.3.3 regression uses the actual production statuses and identifies each new
foreground run by an id baseline captured immediately before send, so it remains
correct across repeated sends and browser/server clock skew.

## Task 2 — implementation evidence

- `light-power-live.png`: exact production-shaped Power event replay in light mode.
- `dark-power-live.png`: the same active stream in dark mode.
- `power-live-stream.gif`: short recording of narration/state/progress updates
  driven by the captured production event order.
- `reduced-motion.png`: reduced-motion rendering with the newest narration line
  immediately complete.
- `power-completed-collapsed.png`: terminal event collapses the run to one replay
  line.

Lite intentionally keeps the persistent `Zero is working · <phase>` anchor,
step count/progress, and Stop control visible while leaving the detailed run
body collapsed by default. Eco and Power open the standard live detail; Pro
opens the detailed live view. All modes consume the same real events.

## Verification

- Production raw capture audit: `74` frames, first `queued`, last `completed`;
  gzip round-trip and SHA-256 verified.
- Focused Vitest: `38/38` passed across pending-run selection, activity mapping,
  narration/reduced-motion behavior, and run grouping.
- Frontend TypeScript: passed.
- ESLint on all changed TypeScript/TSX files: passed with zero warnings.
- Frontend suite excluding the frozen Ora-only sidebar suite: `936/936` passed.
- The unfiltered suite also ran all `936` tests successfully, but Vitest marked
  the unrelated frozen Ora sidebar suite as a setup failure before collecting
  its tests (`file:///logo.png` is not an absolute filesystem path). No Ora or
  Orax file was changed to work around that out-of-scope harness issue.
