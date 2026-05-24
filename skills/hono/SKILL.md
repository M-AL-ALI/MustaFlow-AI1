---
name: hono
description: Build ultrafast Hono APIs that deploy to Cloudflare Workers, Bun, Deno, or Node.
triggers: [hono, cloudflare workers, edge api, workers]
---

# Hono skill

Use when the user asks for a Hono API, Cloudflare Worker, or edge-runtime API. Hono runs on Workers, Bun, Deno, and Node with the same code.

## Required structure

- `src/index.ts` — `new Hono()` + routes.
- `package.json` — `hono` + your runtime adapter (`@hono/node-server`, `wrangler`, etc.).
- For Cloudflare Workers: `wrangler.toml` with `main = "src/index.ts"`.

## Do

- Use `c.json(...)`, `c.text(...)`, `c.html(...)`, `c.redirect(...)` for responses.
- Use `c.req.json()` / `c.req.formData()` / `c.req.param("id")` for input.
- Group routes with `new Hono().basePath("/api/v1")`.
- Use `@hono/zod-validator` for typed request validation.
- For env: in Workers it's `c.env` (bindings); in Node it's `process.env`.

## Don't

- Don't import Node-only modules (`fs`, `path`) if you target Workers — use `@hono/node-server`'s ecosystem only for Node deployments.
- Don't keep mutable state in module scope on Workers — each request may run on a new isolate.

## Examples

### Tiny REST API (Node)

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

app.get("/", (c) => c.text("OK"));
app.get("/items/:id", (c) => c.json({ id: c.req.param("id") }));
app.post("/items", async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
```

### Zod-validated POST

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono();
const schema = z.object({ email: z.string().email(), name: z.string().min(1) });

app.post("/users", zValidator("json", schema), (c) => {
  const data = c.req.valid("json"); // typed
  return c.json({ created: data }, 201);
});

export default app;
```

### Cloudflare Worker

```ts
import { Hono } from "hono";

type Bindings = { DB: D1Database };
const app = new Hono<{ Bindings: Bindings }>();

app.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, email FROM users").all();
  return c.json(results);
});

export default app;
```
