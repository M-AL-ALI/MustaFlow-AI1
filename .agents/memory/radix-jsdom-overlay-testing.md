---
name: Radix overlay testing in mustaflow jsdom
description: How to test components that use Radix Popover/DropdownMenu/Select under vitest+jsdom in artifacts/mustaflow
---

# Radix overlay testing (mustaflow, vitest + jsdom)

Radix UI overlays (Popover, DropdownMenu, Select, …) call Pointer Capture and
`scrollIntoView` APIs that jsdom does not implement. Without shims, a `user-event`
click on a Radix trigger throws and the overlay never mounts.

**Rule:** `artifacts/mustaflow/src/test-setup.ts` installs no-op stubs for
`Element.prototype.hasPointerCapture/setPointerCapture/releasePointerCapture/scrollIntoView`
(guarded by `if (!…)`). Keep them — removing them silently breaks any test that
opens a Radix overlay.

**How to test overlay content:**
- Open the overlay by clicking its trigger with `userEvent.click(...)` (async; await it).
- Radix **portals** content onto `document.body`, NOT the render `container`. Query
  `document.body` (or testing-library `screen`), not the `{ container }` from `render`.

**Why:** these are well-known jsdom gaps; the alternative (asserting only on the
inline trigger) loses coverage of the actual menu-item wiring.
