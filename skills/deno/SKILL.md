---
name: deno
description: Use Deno 2 with Deno.serve, JSR/npm imports, and the built-in permission model.
triggers: [deno, deno.serve, jsr]
---

# Deno skill

Use when the user asks for a Deno project. Deno 2 has first-class npm support (`npm:react`) and JSR for first-party packages.

## Setup

- `deno.json` — config + tasks + import map. No `package.json` needed.
- TypeScript runs natively.
- Run: `deno run --allow-net --allow-read main.ts` (permissions are explicit).
- Tasks: `deno task dev`.

## Permissions

Every IO is gated. Common flags:

- `--allow-net=:8000,api.example.com`
- `--allow-read=./data`
- `--allow-env=DATABASE_URL`
- `--allow-write=./uploads`

Use `-A` only in dev.

## Imports

- JSR: `import { z } from "jsr:@zod/zod@4"`.
- npm: `import express from "npm:express@5"`.
- HTTPS: `import { ... } from "https://deno.land/std@0.224.0/..."` (legacy; prefer JSR).
- Import maps in `deno.json` keep imports tidy.

## Do

- Use `Deno.serve` for HTTP servers (`fetch`-style handlers).
- Use `Deno.env.get("KEY")` — never `process.env`.
- Use `Deno.readTextFile` / `Deno.writeTextFile` for files.
- Use `Deno.test` for tests; run with `deno test`.

## Don't

- Don't `import "fs"` — use Deno's APIs (or `node:fs` if you really need Node compat).
- Don't use `-A` in production — list exact permissions in your deploy command.

## Examples

### HTTP server

```ts
// main.ts
Deno.serve({ port: 8000 }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/") return new Response("Hello from Deno");
  if (url.pathname === "/api/time") {
    return Response.json({ now: new Date().toISOString() });
  }
  return new Response("Not found", { status: 404 });
});
```

Run: `deno run --allow-net main.ts`.

### deno.json with tasks + import map

```json
{
  "tasks": {
    "dev": "deno run --watch --allow-net --allow-env main.ts"
  },
  "imports": {
    "zod": "jsr:@zod/zod@4",
    "@std/assert": "jsr:@std/assert@1"
  }
}
```

### Test

```ts
import { assertEquals } from "@std/assert";

Deno.test("addition", () => {
  assertEquals(1 + 2, 3);
});
```
