---
name: Orax wiring test relative paths
description: Correct relative path depths from the wiring test file to workspace-level dirs (lib/, scripts/) vs artifact siblings.
---

The wiring test lives at:
`artifacts/mustaflow/src/lib/__tests__/orax-wiring.test.ts`

Resolving up to the workspace root requires **5** levels (`../../../../../`):
`__tests__` → `lib` → `src` → `mustaflow` → `artifacts` → workspace root

Then:
- `../../../../../lib/db/src/schema/orax-desktop.ts` → `lib/db/src/schema/orax-desktop.ts` ✓
- `../../../../../scripts/src/migrate-*.ts` → `scripts/src/migrate-*.ts` ✓

Sibling artifacts only need **4** levels (`../../../../`):
- `../../../../api-server/src/routes/...` → `artifacts/api-server/src/routes/...` ✓
- `../../../../orax-desktop/src/...` → `artifacts/orax-desktop/src/...` ✓
- `../../../../ora-mobile/...` → `artifacts/ora-mobile/...` ✓

**Why:** `../../../../` from the test goes up to `artifacts/` root, not the workspace root.
Using `../../../../lib/...` resolves to `artifacts/lib/...` which doesn't exist — causes ENOENT.

**Desktop tsconfigs:** `artifacts/orax-desktop` has NO `tsconfig.json` at root.
Use `tsconfig.web.json` for renderer and `tsconfig.node.json` for main process.
`npx --prefix artifacts/orax-desktop tsc -p artifacts/orax-desktop/tsconfig.web.json --noEmit`
