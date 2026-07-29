# Wave D Task 2 — living Page map evidence

Date: 2026-07-28

## Before and after

- Before: [`../task1/workspace-after-five-things.png`](../task1/workspace-after-five-things.png)
- After, living table of contents:
  [`page-map-living-contents.png`](page-map-living-contents.png)
- Existing graph/editor preserved as Connections:
  [`page-map-connections-preserved.png`](page-map-connections-preserved.png)

The after images were captured in headed Chrome against the local frontend with a deterministic,
production-shaped read-only fixture. The temporary fixture/auth adapter is not part of the feature
commit.

## Page cards

Every card shows:

- page name;
- concrete route, or `Not built yet`;
- purpose (page-map notes first, a plain-language page-type fallback second);
- status: `Ready`, `New`, `Updating`, `Planned`, or `Needs attention`.

New node IDs fade and slide in for 900 ms. Existing cards do not reanimate during ordinary node
edits.

## Live update path

The existing contract is unchanged:

1. The task stream emits `page_map_updated`.
2. `[id].tsx` invalidates `getGetPageMapQueryKey(projectId)`.
3. The existing Page map query receives the current server snapshot.
4. Card state updates from that snapshot; newly observed IDs receive the calm entrance.

No event name, payload, endpoint, or stream was added or renamed.

## Preview interaction

Clicking a built card derives a concrete route and sends a one-shot navigation request to the
existing Preview component. In the headed check:

- clicked card: `Tasks`;
- derived route: `/tasks`;
- Preview link after the click: `/api/projects/45/preview/tasks?t=1`;
- screenshot:
  [`page-map-card-opened-tasks-route.png`](page-map-card-opened-tasks-route.png).

Planned pages and dynamic routes such as `/projects/:id` open their page details instead of
pretending a concrete preview route exists.

## Checks

- Frontend TypeScript: pass.
- Page-card model tests: 3 passed.
- ESLint on all Task 2 source/test files: pass with zero warnings.
- `git diff --check`: pass.
