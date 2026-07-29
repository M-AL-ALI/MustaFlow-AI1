# Wave D.3 Task 10 — transitions, themes, and accessibility

## Motion

- New activity, narration, QA, recovery, results, ideas, errors, and replay detail use
  restrained 150–200 ms fade-ins only under Tailwind's `motion-safe` variant.
- Active icons and the new-activity ping use `motion-safe:animate-*`.
- Interactive color, opacity, and rotation transitions use
  `motion-reduce:transition-none`.
- Word-by-word narration already checks
  `matchMedia("(prefers-reduced-motion: reduce)")`; reduced-motion users receive the
  complete line immediately rather than a token timer.
- The shared `AgentIcon` already listens for changes to that media query and switches
  Zero's mark to its static state.

## Accessibility

- Live activity, narration, and QA are polite `role="log"` regions with
  `aria-relevant="additions text"`.
- Recovery announces polite progress; the calm error treatment is a semantic alert.
- Zero's avatar is exposed as an image named `Zero`.
- Whole-run progress has the accessible name
  `Build progress: step N of M`.
- Run groups identify themselves as active or completed build activity.
- The ideas disclosure exposes `aria-expanded` / `aria-controls`; its icon-only Save,
  Edit, and Dismiss actions have idea-specific accessible names.
- Every new inline action has a keyboard-visible focus ring.

## Theming

All new thread surfaces use semantic design tokens (`background`, `card`, `foreground`,
`muted-foreground`, `border`, `primary`, `primary-foreground`, `destructive`) rather
than light-only or dark-only values. Icons remain color-neutral and inherit the current
text color except the semantic error token.

## Evidence

- `light-live.png`, `dark-live.png`: consolidated live state covering the run group,
  Zero avatar, progress, activity, word-stream narration, QA, recovery, calm error,
  inline results, checkpoint, ideas, and jump-to-latest surface.
- `light-resolved.png`, `dark-resolved.png`: the same surfaces after active states swap
  to static resolved states.
- `light-motion-polish.gif`, `dark-motion-polish.gif`: short live → resolved recordings.

Browser semantic inspection repeated in both themes found:

- 3 polite log regions
- 1 calm alert region
- 1 Zero image role
- exact `Build progress: step 4 of 25`
- 19 rendered `motion-safe` classes
- 13 rendered `motion-reduce` classes

The evidence harness imported the production inline primitives with the application
stylesheet and was removed before commit.

## Verification

- Focused Vitest: 33 tests passed across accessibility, activity, narration, run
  grouping, results, error recovery, ideas, and recovery-loop behavior.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
