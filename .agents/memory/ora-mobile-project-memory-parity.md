---
name: Ora mobile project-scoped memory parity
description: How project memories are wired on mobile — context, API, memory screen, chat path.
---

## Key decisions

**Why ActiveProjectContext?**
`activeProjectId` lived as local state in the 4000-line `index.tsx`. The memory
screen is a separate drawer route and had no way to read it. Creating a small
context (provider wraps `<Drawer>` in `_layout.tsx`) lets both screens share
the value without prop-drilling.

**Rule:** `setActiveProjectId` in `index.tsx` now comes from `useActiveProject()`,
not local useState. The `activeProjectIdRef` pattern is unchanged (ref mirrors
context value on every render for closure safety).

**ChatRequest.oraProjectId:** must be added to the `ChatRequest` type in
`lib/types.ts` or TypeScript rejects it in the non-streaming `chatReq` object.
The streaming path already had it (it was on `RealtimeSessionContext`).

**Memory API signatures:**
- `listMemories(oraProjectId?)` → URL `?oraProjectId=<id>` for project scope
- `createMemory(title, content, oraProjectId?)` → spread into body
- `saveOraMemory(fact, oraProjectId?)` → spread into body
- `clearAllMemories()` → DELETE /api/ora/memories
- `getMemoryUsage()` → GET /api/ora/memories/usage

**Memory screen:** `ProjectMemoriesTab` receives `projectId: number` prop and
calls `listMemories(projectId)` / `createMemory(…, projectId)`. The "Project"
pill tab only renders when `activeProjectId != null`. Superseded memories
(supersededBy !== null) are shown in a separate greyed-out section with a
Restore button that calls `updateMemory(id, { enabled: true })`.

**Tests:** 39 source-string snapshot tests in `lib/__tests__/ora-mobile-parity.test.ts`.
Vitest config only runs `lib/**/*.test.ts` so the test file must live in `lib/`.
