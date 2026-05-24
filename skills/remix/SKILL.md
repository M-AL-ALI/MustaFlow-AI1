---
name: remix
description: Build Remix apps with nested routes, loaders, actions, and progressive-enhancement forms.
triggers: [remix, remix.run]
---

# Remix skill

Use when the user asks for a Remix app. Remix is router-first: every route file exports a `loader` (data), `action` (mutation), and a default component.

## Required structure

- `app/root.tsx` — root layout with `<Outlet />`, `<Links />`, `<Meta />`, `<Scripts />`.
- `app/routes/_index.tsx` — home route.
- `app/routes/posts.tsx` — `/posts`.
- `app/routes/posts.$id.tsx` — `/posts/:id` (dollar sign = dynamic segment).
- `app/routes/posts._index.tsx` — `/posts` index when there are children.

## Loaders & actions

```tsx
import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";

export async function loader() {
  return json({ todos: await db.select().from(todos) });
}

export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  await db.insert(todos).values({ text: String(form.get("text")) });
  return redirect("/todos");
}
```

## Do

- Use `<Form method="post">` instead of `onSubmit` — Remix gives you progressive enhancement and revalidation for free.
- Throw `Response` objects from loaders for 404 / redirect (`throw new Response(null, { status: 404 })`).
- Co-locate route resources: `app/routes/posts.$id.tsx` for the page, same file for loader/action.
- Use `useFetcher` for non-navigation mutations (likes, autosave).

## Don't

- Don't fetch in `useEffect` — fetch in `loader` so SSR + caching work.
- Don't access `window` / `document` in loaders or top-level component bodies.

## Examples

### List + create with one route

```tsx
// app/routes/todos.tsx
import { json, redirect, type ActionFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { db } from "~/db.server";

export async function loader() {
  return json({ todos: await db.todos.findAll() });
}

export async function action({ request }: ActionFunctionArgs) {
  const data = await request.formData();
  const text = String(data.get("text") ?? "").trim();
  if (!text) return json({ error: "text required" }, { status: 400 });
  await db.todos.create({ text });
  return redirect("/todos");
}

export default function Todos() {
  const { todos } = useLoaderData<typeof loader>();
  return (
    <>
      <ul>
        {todos.map((t) => (
          <li key={t.id}>{t.text}</li>
        ))}
      </ul>
      <Form method="post">
        <input name="text" />
        <button>Add</button>
      </Form>
    </>
  );
}
```

### Dynamic route + 404

```tsx
// app/routes/posts.$id.tsx
import { json, type LoaderFunctionArgs } from "@remix-run/node";

export async function loader({ params }: LoaderFunctionArgs) {
  const post = await db.posts.findById(params.id!);
  if (!post) throw new Response("Not found", { status: 404 });
  return json({ post });
}
```
