# Wave D Task 3 - project Image Studio evidence

Date: 2026-07-28

## Before and after

- Before: [`../task1/workspace-after-five-things.png`](../task1/workspace-after-five-things.png)
- Project gallery:
  [`image-studio-project-gallery.png`](image-studio-project-gallery.png)
- Small gallery in the Chat thread:
  [`image-gallery-in-chat.png`](image-gallery-in-chat.png)
- Live job placeholder and calm status:
  [`image-generation-calm-status.png`](image-generation-calm-status.png)

The after images were captured in headed Chrome against the local frontend with a deterministic,
production-shaped fixture. The temporary fixture/auth adapter is excluded from the feature commit.

## Existing pipelines reused

- Project generation and regeneration POST to the existing `/api/images/generate` job route with
  `projectId`, quality, aspect ratio, style, purpose, and one variation.
- The gallery refreshes through the existing project-filtered
  `/api/images?projectId=<id>&limit=50` list. Pending/generating rows keep the existing job poll
  alive; completed and failed states remain authoritative.
- Images created by Zero are discovered from the existing persisted `generate_image` task events.
  The richer completion event supplies `path`, `mimeType`, and optional `previewDataUri`.
- Persisted project image files are a fallback index, so an older generated asset remains reachable
  even when its task event is outside the recent event-enrichment window.

No image event, job payload, streaming contract, or generation pipeline was added or renamed.

## In-thread and workspace behavior

- While an Image Studio job is pending, both the Chat header and the small in-thread gallery say
  `Creating images for your app...`.
- Once ready, the thread shows a bounded four-image gallery with a `View all` action.
- The workspace `Images` surface is under `More`, preserving the default five-things view. It lists
  Image Studio results and Zero-created project assets together.
- Every ready card exposes `Regenerate` and `Insert into app`.

## Insert path exercised

The headed interaction clicked `Insert into app` on a completed Image Studio result. The client:

1. reads the exact bytes from the existing authenticated `/api/images/<imageId>/file` route;
2. stores them through the existing `POST /api/projects/<projectId>/files` route at
   `assets/generated/image-studio-<imageId>.webp` (HTTP 409 means the same asset is already present);
3. sends the existing build handoff telling Zero to place that project path in the visible app;
4. returns to Preview and refreshes the file list/preview.

The browser moved from Images to Preview after the click, confirming the complete client handoff.

## Checks

- Frontend TypeScript: pass.
- Calm-status and project-image model tests: 5 passed.
- ESLint on all Task 3 source/test files: pass with zero warnings.
