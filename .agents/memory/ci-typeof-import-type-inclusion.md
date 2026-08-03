---
name: CI typeof-import in type position causes static file inclusion
description: A `typeof import("../routes/foo")` in a type position is resolved statically by TypeScript, pulling the target file into the tsconfig compilation — even if the dynamic import itself is never awaited at runtime. This broke the scripts/ typecheck when billing-settlement-outbox.ts used `typeof import("../routes/credits").deductCreditsAtomic` as a function signature type.
---

## Rule
Any `typeof import("../some/file")` expression used in a *type* position (function parameter type, return type, conditional type, etc.) is a static reference. TypeScript includes that file in the compilation even when the same `await import()` call is purely dynamic at runtime.

**Why:** TypeScript resolves type-level import expressions at compile time to provide type safety. It does not defer them the way it defers runtime `await import()` calls.

**How to apply:**
- If a lib module needs parameter/return types from another module, import the type explicitly (`import type { Foo } from "./foo"`) or define a shared interface in a common location.
- Do NOT use `typeof import("../routes/foo").Bar` in signatures inside lib files — it drags the route file (and all its Express deps) into any tsconfig that includes the lib file.
- The fix applied here: move all pure utility functions out of `routes/credits.ts` into `lib/credits.ts`. Routes only contains Express handlers. `billing-settlement-outbox.ts` now uses `typeof import("../lib/credits").deductCreditsAtomic`.
