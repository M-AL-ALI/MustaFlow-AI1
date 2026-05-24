---
name: sveltekit
description: Build SvelteKit apps with file-based routing, load functions, and form actions.
triggers: [svelte, sveltekit, kit]
---

# SvelteKit skill

Use when the user asks for a Svelte, SvelteKit, or Kit app. Generated apps use Svelte 5 + SvelteKit 2.

## Required structure

- `src/app.html` — HTML shell with `%sveltekit.head%` and `%sveltekit.body%`.
- `src/routes/+page.svelte` — home page.
- `src/routes/+layout.svelte` — shared layout.
- `src/routes/<r>/+page.server.ts` — server-only `load` and form actions.
- `src/routes/<r>/+page.ts` — universal `load` (runs both server and client).
- `src/routes/api/<r>/+server.ts` — endpoint handlers.
- `svelte.config.js` — adapter (use `@sveltejs/adapter-auto`).

## Load functions

- `+page.ts` exports `load({ fetch, params })` for universal data.
- `+page.server.ts` exports `load(...)` for server-only (DB, secrets).
- Returned data is available in `+page.svelte` via `export let data` (Svelte 4) or `let { data } = $props()` (Svelte 5).

## Form actions

Server-side form handlers live in `+page.server.ts` under `export const actions = { ... }`. Forms POST to the same route — progressive enhancement is free.

## Do

- Use file-based routing — folders inside `src/routes/` map to URLs.
- Use `$lib` alias for shared modules (`src/lib/`).
- For runes (Svelte 5): `$state`, `$derived`, `$effect`, `$props`.
- Use `<form method="POST" use:enhance>` for progressive-enhancement forms.

## Don't

- Don't put secrets in `+page.ts` — it runs on the client too. Use `+page.server.ts`.
- Don't import server-only modules from `$lib` into client components.

## Examples

### Page with server load + form action

```ts
// src/routes/todos/+page.server.ts
import type { Actions, PageServerLoad } from "./$types";
import { fail } from "@sveltejs/kit";

export const load: PageServerLoad = async () => {
  return { todos: await db.select().from(todos) };
};

export const actions: Actions = {
  create: async ({ request }) => {
    const data = await request.formData();
    const text = String(data.get("text") ?? "");
    if (!text) return fail(400, { error: "text required" });
    await db.insert(todos).values({ text });
    return { success: true };
  },
};
```

```svelte
<!-- src/routes/todos/+page.svelte -->
<script lang="ts">
  import { enhance } from "$app/forms";
  let { data } = $props();
</script>

<ul>
  {#each data.todos as todo}<li>{todo.text}</li>{/each}
</ul>

<form method="POST" action="?/create" use:enhance>
  <input name="text" required />
  <button>Add</button>
</form>
```

### API endpoint

```ts
// src/routes/api/hello/+server.ts
import { json } from "@sveltejs/kit";

export async function GET() {
  return json({ message: "hello" });
}
```
