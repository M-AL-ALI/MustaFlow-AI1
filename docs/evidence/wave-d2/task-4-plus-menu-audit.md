# Task 4 - plus menu audit and cleanup

## Scope and method

The before inventory was captured read-only on production project 45. The
after inventory and interaction audit used the production-shaped local bundle
with project 45's captured content. No production mutation was sent.

The final menu has nine actions in three plain-language groups:

- Create: Generate image, Brainstorm, Templates
- Plan: Plan first, Plan history, Explain my app
- Run: Work in background, Add queued task, Fix or improve...

## Before/after inventory

| Original entry | Result | Reason and working proof |
| --- | --- | --- |
| Generate image | Kept under Create | Opened the inline image prompt; one `Describe an image` input appeared. No generation request is sent until Generate is pressed. |
| Brainstorm | Kept under Create | Opened the project-aware `Brainstorm your idea` panel for project 45. |
| Add queued task | Kept under Run | Added a second row and rendered `Queue - 2 tasks`. This is multi-request composition, not background execution. |
| Plan first | Kept under Plan | Toggled immediately and the menu returned `Plan first on`. |
| Work in background | Kept under Run | Toggled immediately and the menu returned `Work in background on`. It remains distinct from adding multiple queued prompts. |
| Templates | Kept under Create | Opened the `Plan Templates` dialog with search and template selection. |
| Generate variants | Removed from menu; contextual action kept | It duplicated a specialized switch. Typing `Redesign the landing page layout` rendered the existing `Generate 2 variants` action, now outside the unrelated issue-count gate. |
| Plan history | Kept under Plan | Opened the `Plan History` dialog and its honest empty state. |
| Debug project | Collapsed into Fix or improve... | A generic editable fix prompt lets Zero choose the relevant diagnosis instead of exposing an internal route. |
| Review project | Collapsed into Fix or improve... | Same Zero-decides flow; specific review machinery remains available behind the prompt. |
| Explain project | Renamed Explain my app | Prefilled `Explain how this app works in plain language, including its pages, data flow, and important behavior.` |
| Improve project | Collapsed into Fix or improve... | Prefilled the editable `Fix or improve this app: ` prompt. |
| Fix tests | Collapsed into Fix or improve... | Zero chooses the appropriate fix; the contextual Fix Issues surface still offers the specific test action when a failing test is actually detected. |
| Fix TypeScript | Collapsed into Fix or improve... | Zero chooses the appropriate fix; the contextual Fix Issues surface still offers the TypeScript action when detected. |
| Fix lint | Collapsed into Fix or improve... | Zero chooses the appropriate fix; the contextual Fix Issues surface still offers the lint action when detected. |
| Lite | Removed from plus menu | Available only in the dedicated Mode control. |
| Eco | Removed from plus menu | Available only in the dedicated Mode control. |
| Power | Removed from plus menu | Available only in the dedicated Mode control. |
| Pro | Removed from plus menu | Available only in the dedicated Mode control. |

No audited action was wired to nothing. `Add queued task` and `Work in
background` were retained separately because they control different behavior:
one composes multiple requests, while the other chooses background execution.

## Evidence

- `task-4-menu-before.png` - the production menu with 19 visible entries,
  including four duplicated modes.
- `task-4-menu-after.png` - the final nine-action grouped menu.

The final screenshot also shows `Generate 2 variants` appearing contextually
for a design request, proving that removing it from the menu did not remove the
capability.

## Files and contracts

- `queue-composer.tsx` - grouped menu, two plain-language macros, removed
  hidden duplicate menu, and moved the contextual variant affordance outside
  the issue-only wrapper.
- `queue-composer-menu.test.ts` - inventory exclusions, Mode ownership, and
  contextual variant reachability.

Frontend only. No backend files, API/event contracts, pricing, charge points,
or confirmation behavior changed.

## Verification

- Mustaflow TypeScript: pass
- Menu and Mode focused tests: 7 passed; final menu test: 3 passed
- ESLint on Task 4 files: pass
- Vite production bundle: pass (4,033 modules transformed)
