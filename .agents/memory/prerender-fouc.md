---
name: Prerender SEO fallback FOUC
description: Why the public landing page flashes unstyled HTML on refresh and how it's hidden from humans while kept for bots.
---

# Prerender SEO fallback causes a flash of unstyled content

The mustaflow web artifact is a Vite SPA whose post-build prerender scripts
(`artifacts/mustaflow/scripts/prerender.ts` for static routes, and
`scripts/src/prerender-dynamic-routes.ts` for `/gallery/:slug`, `/u/:username`)
inject **plain semantic HTML with NO Tailwind classes** directly inside
`<div id="root">…</div>` so non-JS crawlers (GPTBot, ClaudeBot) get real
headings/copy/links in the raw HTTP response.

On real browsers this fallback paints first and is only replaced when the React
bundle downloads + executes and `createRoot().render()` swaps out `#root`. That
gap is the sub-second flash of unstyled black-on-white text users reported on
refresh — it is NOT a CSS-loading delay.

**Fix:** wrap the injected fallback in `<div data-prerender-fallback>…</div>`
(both prerender scripts must do this) and hide it with an inline `<style>` in the
`<head>` of BOTH entry HTML files (`index.html` and `public.html`):
`[data-prerender-fallback] { display: none !important; }`.

**Why this is safe for SEO:** `display:none` does not remove the markup from the
HTML source, so non-JS bots that parse raw HTML still read it. Googlebot renders
JS and indexes the full React app anyway. Humans see only the dark themed
background (set pre-paint by the inline theme script) until React mounts.

**How to apply / gotchas:**
- The inline `<style>` must be in `<head>` (parsed before first paint) — a CSS
  file link would itself load too late.
- `prerender.ts` uses `index.html` as its template (NOT `public.html` — that
  strips Clerk and breaks authenticated routes). Keep both HTML heads in sync.
- Cannot be reproduced in the dev preview: the prerender only runs at build time,
  so dev serves an empty `#root` and the style is a no-op. Verify by inspecting
  built `dist/public/**/index.html` or the deployed site.
