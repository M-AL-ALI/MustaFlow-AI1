---
name: Flex scroll container with max-height
description: h-full on a child of a flex-1 item fails when the flex container uses only max-height — overflow-y-auto must be on the flex item itself.
---

## Rule

Do NOT use `h-full overflow-y-auto` on a child div inside a `flex-1 min-h-0` wrapper when the ancestor flex container only has `max-height` (not an explicit `height`).

Instead, put `overflow-y-auto` directly on the `flex-1 min-h-0` flex item itself.

```jsx
// WRONG — h-full resolves to auto when parent height is not definite
<div className="flex-1 min-h-0">
  <div className="h-full overflow-y-auto">...</div>
</div>

// CORRECT — flex algorithm constrains height first, overflow clips at that boundary
<div className="flex-1 min-h-0 overflow-y-auto">
  <div className="px-4 py-4">...</div>
</div>
```

For sticky/absolute overlays inside the scroll container (e.g. a "scroll to latest" button), use `sticky bottom-2` inside the scroll container rather than `absolute` inside an outer wrapper.

**Why:** CSS spec — `height: 100%` is only definite when the containing block has an explicit `height` property. `max-height` alone is NOT definite. Flex items get their height from the flex algorithm ("used" height), but that used height does not make the item a definite containing block for percentage resolution in its children. So `h-full` on a child resolves to `auto`, the child grows to content height, and overflow never engages. This causes content to render behind sibling `shrink-0` elements (e.g. a fixed composer bar).

**How to apply:** Any time a scrollable feed/list lives inside a flex column where the outer container uses `max-height` (common in mobile drawers, bottom sheets, modals). The Ora mobile drawer (`max-h-[85dvh]`) hit this bug. The fix was applied in `ora-bubble.tsx` and `ora-panel.tsx`.
