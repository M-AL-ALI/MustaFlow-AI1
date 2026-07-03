---
name: Orax Desktop Phase 2C lessons
description: Pitfalls hit when building the Electron+Vite+React orax-desktop skeleton — TypeScript, pnpm, and wiring-test gotchas.
---

## typescript not in pnpm catalog
`typescript` has no catalog entry; writing `"typescript": "catalog:"` in package.json
causes an install error. Use an explicit version: `"~5.9.2"` (matching ora-mobile).

**Why:** The pnpm catalog only pins specific deps; typescript is managed at each
package level.

**How to apply:** Any new Electron/Node artifact that needs typescript must pin it
explicitly, not via `catalog:`.

## Parameters<typeof fn> fails for zero-param functions
In ipc.ts renderer, using `Parameters<typeof api>["0"]["on"]["hostStateChanged"][0]` as
a callback type fails with TS2493 "Tuple type '[]' has no element at index '0'" because
`api()` takes no parameters. Fix: use explicit inline type imports for callback shapes.

```ts
// WRONG
(cb: Parameters<typeof api>["0"]["on"]["hostStateChanged"][0])

// RIGHT
(cb: (state: import("../../shared/types").HostState) => void)
```

## app.whenReady() method chain is multi-line in source
The pattern `app\n  .whenReady()` does NOT match `.toContain("app.whenReady")` in
wiring tests. Assert `.toContain(".whenReady()")` instead (the method call substring
is unambiguous and always present).

## Wiring-test word-in-prose false positives
`.not.toContain("password")` fails when the UI shows "No password is entered here."
(a legitimate disclaimer). Only ban the actual input element: `.not.toContain('type="password"')`
and `.not.toContain("<input")`.

## Electron binary blocks in Replit
`electron` runs a postinstall download script. It is silently blocked by the pnpm
build-script guard. Set `electron_skip_binary_download=1` in `.npmrc` and install with
`HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @workspace/orax-desktop install`.
Run `pnpm approve-builds` only for production-machine builds.

## Two separate tsconfigs for Electron packages
Electron apps require two tsconfig files (`tsconfig.node.json` for main+preload,
`tsconfig.web.json` for renderer) because they target different environments
(`node16`/`module: CommonJS` vs `bundler`/`DOM`). Do NOT use a composite setup — keep
them as simple `--noEmit` projects. Include `src/shared/**/*` in both so types are
shared without duplication.
