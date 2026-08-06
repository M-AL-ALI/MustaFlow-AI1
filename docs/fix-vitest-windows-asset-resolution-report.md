# Windows Vitest public-asset resolution fix

Status: **accepted locally; branch not merged**

- Branch: `codex/fix-vitest-windows-asset-resolution`
- Base: `3f23b4b1ad54f4a51c2443ac13d2abbbad7c54dc`
- Scope: web test harness only

## Root cause

`ora-fresh-start.test.tsx` imports `OraSidebar`, which imports the public-root asset `/logo.png`. On the Windows lab, Vitest/Vite allowed that unresolved root path to reach filesystem conversion as `file:///logo.png`. Windows rejected it before the test module registered, producing:

```text
TypeError: The argument 'filename' must be a file URL object, file URL string,
or absolute path string. Received 'file:///logo.png'
```

The fresh branch reproduced that exact collection failure before the change.

## Fix

`artifacts/mustaflow/vitest.config.ts` now installs a deterministic pre-resolve Vitest plugin for public-root image and font imports. Matching imports resolve to a virtual ES module whose default export is the original public URL string. Resolution therefore never reaches the operating-system path converter.

The rule is platform-independent—there is no Windows/Linux conditional—and covers common public static extensions: AVIF, BMP, EOT, GIF, ICO, JPEG, OTF, PNG, SVG, TTF, WebP, WOFF, and WOFF2. It excludes Vite's `/@...` internal identifiers. Production Vite configuration and application/component source are unchanged.

## Verification

| Check                        | Result                                                |
| ---------------------------- | ----------------------------------------------------- |
| Pre-fix Windows reproduction | exact `file:///logo.png` TypeError; 0 tests collected |
| Focused Windows run 1        | 1 file, 16 tests passed                               |
| Focused Windows run 2        | 1 file, 16 tests passed                               |
| Focused Windows run 3        | 1 file, 16 tests passed                               |
| Focused Windows run 4        | 1 file, 16 tests passed                               |
| Focused Windows run 5        | 1 file, 16 tests passed                               |
| Ora fast stability gate      | 15 checks/groups passed, 0 warnings, 0 failures       |
| Repository typecheck         | passed                                                |
| Repository lint              | passed                                                |

The first pre-commit full gate also passed every group (`pass=14`, `fail=0`); its only warning was the expected dirty-tree notice for the uncommitted configuration file. The table records the final clean-tree gate.

## Diff and dependency status

Behavioral change:

```text
artifacts/mustaflow/vitest.config.ts
```

Documentation only:

```text
docs/fix-vitest-windows-asset-resolution-report.md
```

No production file, component, `package.json`, or `pnpm-lock.yaml` changed. The mandatory isolated clean frozen-lockfile proof is therefore not triggered. The new worktree's unchanged lockfile did install successfully with repository-pinned pnpm 10.26.1.
