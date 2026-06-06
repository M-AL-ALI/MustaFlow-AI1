---
name: Ora Projects active-project scope (route-as-truth + tri-state)
description: How Ora project-scoped conversations resolve their projectId and why the undefined/null/number distinction is load-bearing.
---

The `/ora/projects/:projectId` route is the single source of truth for the active
project — it survives reload because it comes from the URL, not state. The
provider takes `activeProjectId` as a prop derived from the route param.

`newConversation(projectId?)` carries a **tri-state** that must NOT be collapsed:

- `undefined` → defer to the active project (global "New conversation").
- `null` → explicit standalone chat (`projectId = null`), even inside a project.
- a number → that specific project.

`resolveScopeProjectId(explicit, activeProjectId)` (lib/ora-project-scope.ts)
only falls back to the active project when `explicit === undefined`.

**Why:** if `undefined` is coalesced to `null` anywhere (e.g. `pendingProjectIdRef.current ?? null`),
a project-scoped new chat silently saves as standalone — the exact bug this flow fixes.

**How to apply:** keep `pendingProjectIdRef` typed `number|null|undefined` (default
`undefined`); reset it to `undefined` (never `null`) after create/select. Invalid
active project (not in loaded list) must redirect to `/ora` with toast
"That project no longer exists" — never silently fall through to standalone.
