---
name: nextjs-app-router
description: Build Next.js 15 apps with the App Router, Server Components, route handlers, and server actions.
triggers: [next, nextjs, next.js, app router, server components, rsc, server actions]
---

# Next.js App Router skill

Use this whenever the user asks for a Next.js, Next 14/15, App Router, or RSC-based app. Always default to the App Router (`app/` directory) — never the legacy `pages/` directory unless the user explicitly asks for it.

## Required structure

- `app/layout.tsx` — root layout (must include `<html>` and `<body>`).
- `app/page.tsx` — home route.
- `app/<route>/page.tsx` — additional routes.
- `app/api/<route>/route.ts` — route handlers (GET/POST/etc. as named exports).
- `next.config.mjs` — keep minimal; never set `output: 'export'` unless asked.
- `tailwind.config.ts` + `postcss.config.mjs` + `app/globals.css` for Tailwind.

## Server Components by default

Every component is a Server Component unless it has `"use client"` at the very top. Server Components can be `async` and `await` data directly. Only mark a component as client when it uses state, effects, browser APIs, or event handlers.

## Data fetching

- In Server Components: `await fetch(url, { cache: "no-store" })` for dynamic, `{ next: { revalidate: 60 } }` for ISR.
- In Route Handlers (`app/api/x/route.ts`): export `async function GET(req: Request)` returning `Response.json(...)` or `new Response(...)`.
- For mutations from forms: prefer **Server Actions** (`"use server"` directive in an async function exported from a server module or inlined in a Server Component).

## Do

- Use `<Link href="/about">` from `next/link` for client-side navigation.
- Use `<Image>` from `next/image` with explicit `width` + `height` for static images, or `fill` inside a relatively-positioned parent.
- Co-locate route-specific files: `loading.tsx`, `error.tsx`, `not-found.tsx` inside the route folder.
- Read env vars: server-only secrets in `process.env.MY_SECRET`; expose to client only via `NEXT_PUBLIC_*` prefix.

## Don't

- Don't use `getServerSideProps` / `getStaticProps` — those are pages-router only.
- Don't import server-only modules (`fs`, `pg`) into client components.
- Don't put secrets behind `NEXT_PUBLIC_*` — that exposes them to the browser bundle.

## Examples

### Server Component fetching data

```tsx
// app/posts/page.tsx
async function getPosts() {
  const res = await fetch("https://api.example.com/posts", { next: { revalidate: 60 } });
  if (!res.ok) throw new Error("Failed to load posts");
  return res.json() as Promise<{ id: number; title: string }[]>;
}

export default async function PostsPage() {
  const posts = await getPosts();
  return (
    <ul>
      {posts.map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  );
}
```

### Route handler

```ts
// app/api/hello/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ message: "hello" });
}

export async function POST(req: Request) {
  const body = await req.json();
  return NextResponse.json({ echoed: body }, { status: 201 });
}
```

### Server Action from a form

```tsx
// app/todos/page.tsx
import { revalidatePath } from "next/cache";

async function createTodo(formData: FormData) {
  "use server";
  const text = String(formData.get("text") ?? "");
  // await db.insert(...)
  revalidatePath("/todos");
}

export default function TodosPage() {
  return (
    <form action={createTodo}>
      <input name="text" required />
      <button type="submit">Add</button>
    </form>
  );
}
```
