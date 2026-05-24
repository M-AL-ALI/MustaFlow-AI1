---
name: tailwind-v4
description: Style apps with Tailwind CSS v4 — CSS-first config via @theme and the new Vite plugin.
triggers: [tailwind, tailwindcss, utility css, @theme]
---

# Tailwind CSS v4 skill

Use when the user asks for Tailwind. v4 is a major rework: configuration lives in CSS via `@theme`, no `tailwind.config.js` is needed for most projects, and the Vite integration is a dedicated plugin.

## Install (Vite)

```sh
npm install -D tailwindcss @tailwindcss/vite
```

```ts
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";
export default { plugins: [tailwindcss()] };
```

```css
/* src/index.css */
@import "tailwindcss";

@theme {
  --color-brand: oklch(0.72 0.2 250);
  --font-display: "Inter", sans-serif;
  --radius-card: 1rem;
}
```

## Key differences vs v3

- **No JS config by default.** Use `@theme { --color-x: ... }` in CSS — those become `bg-x`, `text-x`, etc.
- **No `@tailwind base/components/utilities`** — replaced by `@import "tailwindcss"`.
- **No PostCSS step** when using `@tailwindcss/vite`. (Use `@tailwindcss/postcss` if you need PostCSS.)
- Color system defaults to **oklch** — better gamut, smoother dark mode.
- Container queries are first-class: `@container` + `@sm:grid-cols-2`.
- Dynamic utility values: `bg-[#abc]`, `grid-cols-[200px_1fr]` — same as v3.

## Do

- Define brand tokens once in `@theme` — they generate all matching utilities.
- Use `@layer components` for repeated patterns (`.btn-primary`).
- Use `dark:` variant for dark mode; set `@variant dark (.dark &);` in CSS to switch from media-query to class-based.
- For shadcn/ui v4: ensure HSL tokens are in `:root` and use `@theme inline { --color-background: var(--background); }`.

## Don't

- Don't migrate to v4 piecemeal — `tailwind.config.js` is mostly ignored. Either commit to CSS-first config or stay on v3.
- Don't use `@apply` for everything — it bloats bundles. Reach for it sparingly.

## Examples

### CSS-first config with dark mode

```css
@import "tailwindcss";
@variant dark (.dark &);

@theme {
  --color-bg: oklch(1 0 0);
  --color-fg: oklch(0.2 0 0);
  --color-accent: oklch(0.7 0.2 240);
}

.dark {
  --color-bg: oklch(0.18 0 0);
  --color-fg: oklch(0.95 0 0);
}
```

```html
<body class="bg-bg text-fg">
  <button class="bg-accent text-bg px-4 py-2 rounded-card">Hi</button>
</body>
```

### Container query

```html
<div class="@container">
  <div class="grid grid-cols-1 @md:grid-cols-2 @xl:grid-cols-3 gap-4">…</div>
</div>
```

### Plugin (PostCSS mode)

```js
// postcss.config.js
export default { plugins: { "@tailwindcss/postcss": {} } };
```
