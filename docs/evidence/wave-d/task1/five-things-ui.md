# Wave D Task 1 — five-things UI evidence

Date: 2026-07-28

## Before and after

- Before: [`../task0/production-eco-selected-no-deep-control.png`](../task0/production-eco-selected-no-deep-control.png)
- After, default workspace: [`workspace-after-five-things.png`](workspace-after-five-things.png)
- After, Plan on the preview side: [`workspace-after-plan-tab.png`](workspace-after-plan-tab.png)

The after images were captured in headed Chrome against the local frontend with a deterministic,
production-shaped read-only fixture. The temporary fixture/auth adapter was excluded from the
feature commit.

## Presentation

- Chat stays on the left.
- Preview stays on the right by default.
- Page map and Plan are first-class tabs in the right pane.
- The Lite/Eco/Power/Pro mode picker and Deep toggle are visible directly below the composer.
- Planning, background work, templates, variants, brainstorm, image generation, queued tasks,
  diagnostics, and code-oriented actions remain reachable from `More`.
- Internal task-event bubbles, live code fragments, queue panels, and duplicated status bars are
  absent from the default thread.
- Advanced workspace tabs and the advanced assistant remain reachable from the top-level `More`
  control.

## Exact calm status vocabulary

- `Ready for your next change.`
- `Answering your question...`
- `Planning your app...`
- `Building your app...`
- `Building — N files so far`
- `Testing what I built...`
- `Fixing an issue I found...`

## Checks

- Frontend TypeScript: pass.
- Focused calm-status tests: 2 passed.
- ESLint on all Task 1 source/test files: pass with zero warnings.
- `git diff --check`: pass.
