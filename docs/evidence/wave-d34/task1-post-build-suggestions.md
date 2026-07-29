# Wave D.3.4 Task 1 — post-build suggestions

## Root-cause classification

Classification: **(b) generation runs but empty/invalid provider output is silently discarded**.

- Successful foreground jobs schedule suggestion generation from `jobs.ts` after task completion.
- Failure completion and staged-task apply paths schedule the same hook.
- `GET /api/projects/:id/suggestions` is read-only; it does not generate rows.
- The previous generator made one direct completion call. Empty arrays, invalid items, parse
  failures, and provider errors returned without a retry, durable diagnostic, or fallback row.
- Production tasks 141 and 143 therefore remained at HTTP 200 with `[]`; extending frontend
  polling would not create data.

## Remediation

- The completion path now calls the existing `createChatCompletion` provider abstraction with
  OpenAI `gpt-5-mini`, `reasoning_effort: "low"`, and `max_completion_tokens: 4000`.
- Empty or semantically invalid output receives exactly one retry. A thrown provider call does
  not add a semantic retry.
- If model output is still unavailable, at most three deterministic suggestions are built only
  from the completed task id, an actual page-map node with a real file path, and the current
  saved plan.
- Diagnostics contain only `finish_reason`, `reasoning_tokens`, `output_tokens`,
  `parsed_count`, and `failure_category`.
- Suggestion insertion remains in the asynchronous post-completion hook. The generator imports
  and calls no credit, billing, deduction, reservation, or refund code.
- No database migration and no API or event contract change was made.

## Production-shaped acceptance

The backend harness used completed build task `901` for project `45`. With two empty model
responses, it persisted three pending rows:

1. `Review the latest task`
2. `Review Task dashboard`
3. `Check the saved plan`

The same honest fallback row was rendered through:

- `InlineIdeas`, proving the inline ideas section shows it.
- `SavedSuggestionsTab`, proving the Ideas tab shows the pending database shape.

No fallback context loader ran in either the first-attempt or retry-success model cases.

## Verification

- `post-build-suggestions.test.ts`: 6/6 passed (valid, empty, invalid, thrown, retry-success,
  deterministic context-bound fallback).
- `inline-ideas.test.tsx` and `saved-suggestions-tab.test.tsx`: 4/4 passed.
- `pnpm run typecheck:libs`: passed.
- API TypeScript: passed.
- NabuFlow frontend TypeScript: passed.
- ESLint on all changed TypeScript/TSX files: passed.
