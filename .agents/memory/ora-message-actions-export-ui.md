---
name: OraMessageActions export/download UI layout
description: Where the labeled download/export actions live in OraMessageActions (desktop vs mobile)
---

# OraMessageActions export/download surfaces

The assistant message action row has two layouts that render together (CSS
`hidden sm:flex` vs `flex sm:hidden`):

- **Desktop**: rich exports are delegated to `<OraExportMenu>` — its trigger is a
  button with `title="Export / Generate"` (no `aria-label`). Copy/Read aloud/
  Regenerate are `aria-label`ed `<ActionButton>`s.
- **Mobile**: a Radix Popover (trigger is the only `<button>` with
  `aria-label="Message actions"` — the desktop toolbar is a `<div role="toolbar">`
  with the same name). Inside are text-labeled items (no aria-label): "Download
  report", "Download JSON", "Download action plan CSV", "Download image analysis",
  "Download document analysis", "Download as Markdown", "Word Report", etc.

**Testing note:** to assert per-format download wiring, open the mobile popover
and match items by `textContent` from `document.body` (portal). Querying labeled
download buttons by `aria-label` returns null — they only have visible text.
