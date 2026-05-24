---
name: astro
description: Build Astro 4 sites: content collections, islands, server endpoints, and SSR adapters.
triggers: [astro, static site, content collections, islands]
---

# Astro skill

Use when the user asks for an Astro site, content site, marketing site, blog, or "fast static site". Astro ships zero JavaScript by default — interactivity is opt-in via island components.

## Required structure

- `src/pages/index.astro` — home page (file-based routing).
- `src/layouts/*.astro` — shared layouts.
- `src/components/*.astro` — page components.
- `src/content/<collection>/*.md` — content collection entries.
- `src/content/config.ts` — zod schemas for collections.
- `astro.config.mjs` — integrations (`@astrojs/tailwind`, framework integrations, adapter).

## Astro component anatomy

```astro
---
// Component script (runs at build/request time on server)
const greeting = "Hello";
const items = await fetch("...").then((r) => r.json());
---
<div>
  <h1>{greeting}</h1>
  {items.map((i) => <p>{i.name}</p>)}
</div>
```

## Islands

To embed an interactive React/Vue/Svelte/Solid component, add the integration in `astro.config.mjs`, then use a `client:*` directive:

- `client:load` — hydrate immediately.
- `client:idle` — hydrate when the browser is idle.
- `client:visible` — hydrate when scrolled into view.
- `client:only="react"` — render only on the client.

## Do

- Use **content collections** for blogs / docs — they give you typed frontmatter and `getCollection()`.
- Prefer `.astro` components for static content; reach for islands only when interaction is required.
- Use `Astro.props` for component props inside the frontmatter script.
- For SSR/endpoints, add an adapter (`@astrojs/node`, `@astrojs/vercel`, etc.) and set `output: "server"`.

## Don't

- Don't add `client:load` to every component — it defeats Astro's "zero JS" advantage.
- Don't put secrets in client-loaded components.

## Examples

### Blog with a content collection

```ts
// src/content/config.ts
import { defineCollection, z } from "astro:content";

export const collections = {
  blog: defineCollection({
    type: "content",
    schema: z.object({
      title: z.string(),
      pubDate: z.date(),
      tags: z.array(z.string()).default([]),
    }),
  }),
};
```

```astro
---
// src/pages/blog/index.astro
import { getCollection } from "astro:content";
import Layout from "../../layouts/Base.astro";
const posts = (await getCollection("blog")).sort(
  (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
);
---
<Layout title="Blog">
  <ul>
    {posts.map((p) => (
      <li><a href={`/blog/${p.slug}/`}>{p.data.title}</a></li>
    ))}
  </ul>
</Layout>
```

### React island

```astro
---
import Counter from "../components/Counter.tsx";
---
<Counter client:visible initial={5} />
```

### Server endpoint

```ts
// src/pages/api/ping.ts
import type { APIRoute } from "astro";
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
```
