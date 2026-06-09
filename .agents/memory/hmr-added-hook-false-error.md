---
name: HMR "rendered more hooks" false positive
description: Adding a hook to a live-edited file throws a runtime error that is a stale Fast Refresh artifact, not a real bug.
---

When you add a new `useState`/`useRef`/`useCallback`/`useEffect` to a hook or component file **while the dev server is running**, the browser console can throw:

- `Rendered more hooks than during the previous render.`
- `Should have a queue. You are likely calling Hooks conditionally...`

**Why:** React Fast Refresh tries to hot-swap the component while preserving its existing hook state. The newly added hook changes the hook count between the preserved render and the new render, which trips React's hooks invariant. It is an artifact of the *incremental* HMR swap, not of the code.

**How to apply:** Before treating it as a real conditional-hooks bug, verify the new hooks are at the top level of the function with no early `return` before them (e.g. `useOraChat` in `artifacts/mustaflow/src/hooks/use-ora-chat.ts`). If they are unconditional, the error is stale — a full page reload clears it, and subsequent clean HMR updates with no recurrence confirm it. Don't refactor working hook code to chase it.
