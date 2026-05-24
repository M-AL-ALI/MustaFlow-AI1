---
name: bun
description: Use Bun as the runtime/bundler/test runner — Bun.serve, bun:sqlite, and bun test.
triggers: [bun, bun.serve, bun:sqlite, bun test]
---

# Bun skill

Use when the user asks for a Bun-based project. Bun is a Node-compatible runtime with built-in bundler, transpiler, and test runner.

## Setup

- `bun init` scaffolds; manually: `package.json` + `bun.lockb` (auto-created).
- Install: `bun add <pkg>`. Run scripts: `bun run <script>`.
- `bunfig.toml` for config (rarely needed).
- TypeScript runs natively — no separate build step.

## Built-in APIs

- `Bun.serve({ port, fetch })` — HTTP server using `fetch`-style handlers.
- `Bun.file(path)` — efficient file reading (returns a `BunFile`/`Blob`).
- `Bun.write(path, data)` — write file.
- `Bun.password.hash/verify` — Argon2id passwords.
- `bun:sqlite` — built-in SQLite driver.
- `bun:test` — Jest-compatible test runner (`bun test`).

## Do

- Prefer Bun's built-ins (`Bun.serve`, `bun:sqlite`) over `express` + `better-sqlite3` when starting fresh — fewer deps, faster.
- Read `process.env` as usual — Bun auto-loads `.env`.
- For HTTP frameworks, Hono and Elysia work great on Bun.
- Use `bun run dev` (not `npm run dev`).

## Don't

- Don't bundle for production — Bun runs TypeScript directly. Bundling only matters for the browser.
- Don't use `require` for new code — ESM works natively.

## Examples

### HTTP server with Bun.serve

```ts
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("OK");
    if (url.pathname === "/api/echo" && req.method === "POST") {
      const data = await req.json();
      return Response.json({ echoed: data });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Listening on http://localhost:${server.port}`);
```

### SQLite

```ts
import { Database } from "bun:sqlite";
const db = new Database("data.sqlite");
db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
const insert = db.prepare("INSERT INTO users (email) VALUES (?)");
insert.run("a@b.com");
const rows = db.prepare("SELECT * FROM users").all();
```

### Tests

```ts
// math.test.ts
import { expect, test } from "bun:test";
test("adds", () => {
  expect(1 + 2).toBe(3);
});
```

Run: `bun test`.
