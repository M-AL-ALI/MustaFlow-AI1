---
name: Wouter Link nested anchors
description: Wouter v3 Link renders <a> by default; wrapping it around a shadcn Button (which also defaults to <a>-ish behavior) or a raw <button> produces invalid HTML and a React hydration warning.
---

**Rule:** never write `<Link href=...><Button>...</Button></Link>` or `<Link href=...><button>...</button></Link>`. Both produce invalid HTML — the first nests `<a><a>`, the second nests `<a><button>` which interactive-content-validates as invalid.

**Correct patterns in this repo:**

1. **Link as a styled anchor** (preferred for nav items and CTAs):

   ```tsx
   <Link href="/projects" onClick={close} className="...flex items-center gap-2 ... no-underline">
     <Plus className="h-4 w-4" />
     Create something new
   </Link>
   ```

   Wouter v3 passes `className` and most DOM props straight through to the underlying `<a>`. Add `no-underline` so Tailwind/global anchor styles don't leak through.

2. **Button asChild around a Link** (when you need full Button variants/sizes):
   ```tsx
   <Button asChild size="sm" variant="outline" className="...">
     <Link href={`/projects/${projectId}`}>
       <Rocket className="h-3.5 w-3.5" />
       Deploy
     </Link>
   </Button>
   ```
   The Link becomes the root element; Button merges its classes via Radix Slot.

**Why:** invalid HTML; React logs `validateDOMNesting` hydration warnings and accessibility tooling rejects the markup. Pages still render so the bug is easy to miss in manual testing — only Playwright/React strict mode surfaces it.

**How to apply:** when adding any link in this repo, default to pattern 1. Only reach for pattern 2 when you genuinely need a shadcn Button variant + Link behavior together.
