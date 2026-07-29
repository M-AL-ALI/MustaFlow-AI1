# Wave D.3 Task 1 — inline build results

Source under test: `artifacts/mustaflow/src/pages/projects/components/inline-build-results.tsx`

The evidence page imported the real component and the Builder stylesheet. It was not a visual
mock. The temporary evidence entry point was removed after capture.

## Acceptance covered

- No bordered `Builder report` artifact.
- A plain-language result sentence leads the message.
- `Files changed`, `Checks`, and `Applied lessons` are collapsed by default.
- Expanding `Files changed` reveals the complete file list.
- The checkpoint remains a real inline action.
- Skipped live validation keeps the same honest deferred-check disclosure, including its fallback
  when a warning payload is absent.
- The same component is used by live chat and Full History.
- Light and dark theme captures use the same markup and data.

## Files

- `dark-collapsed.png`
- `dark-expanded.png`
- `dark-interaction.gif`
- `light-collapsed.png`
- `light-expanded.png`
- `light-interaction.gif`

## Automated verification

```text
pnpm --filter @workspace/mustaflow test -- --run src/pages/projects/components/inline-build-results.test.tsx
Test Files  1 passed (1)
Tests       3 passed (3)

pnpm --filter @workspace/mustaflow typecheck
exit 0

pnpm --filter @workspace/api-server exec vitest run src/tests/builder-access.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
```
