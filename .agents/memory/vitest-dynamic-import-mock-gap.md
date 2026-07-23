---
name: Vitest dynamic-import mock interception gap
description: A sync vi.mock factory can fail to intercept dynamic import() calls inside route handlers; async factory + DB safety-net is the fix pattern.
---

When a smoke test mocks a module with a **sync** `vi.mock("path", () => ({...}))` factory and the route handler imports that module via a **dynamic** `await import("../../lib/...")`, Vitest may not intercept the call. The real module runs instead, hits missing DB table stubs, and throws a silent TypeError — causing the route to return without the expected response fields.

**Fix pattern (dual-layer)**:
1. Change the `vi.mock` factory to **async** and export **all** module-level exports (including constants and helper fns). Vitest is more reliable at intercepting dynamic imports with async factories.
2. Add the missing DB table stubs (`oraAssetsTable`, `oraFileContextsTable`) to the `@workspace/db` mock so the real function doesn't throw even if interception still fails.
3. Add a `dbState` hoisted flag to control whether `makeInsertMutation().returning()` resolves or rejects — lets tests simulate DB failures without relying on mock interception.

**Why**: The sync factory for `vi.hoisted`-backed mocks occasionally misses dynamic `import()` paths in Express route handlers. The async factory triggers a different Vitest code path that handles it correctly.

**How to apply**: Whenever a route handler uses `await import(...)` for a dependency and a smoke test needs to mock it, use an async factory and stub all its exports. Also add the table stubs to the DB mock as a safety net.
