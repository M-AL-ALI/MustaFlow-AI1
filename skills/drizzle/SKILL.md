---
name: drizzle
description: Use Drizzle ORM with Postgres — schema, migrations, typed queries, and drizzle-kit.
triggers: [drizzle, drizzle-orm, drizzle-kit, orm]
---

# Drizzle ORM skill

Use for typed SQL access from TypeScript with no runtime surprises. Drizzle reads/writes plain Postgres (no client-side query parser) and gives you compile-time types from your schema.

## Install (Postgres)

```sh
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

## Schema

```ts
// src/schema.ts
import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  userId: serial("user_id").references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

## Client + migrations

```ts
// src/db.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

```ts
// drizzle.config.ts
import type { Config } from "drizzle-kit";
export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
```

- `drizzle-kit generate` — produce SQL migration files from schema diff.
- `drizzle-kit migrate` — apply pending migrations.
- `drizzle-kit push` — push schema directly to DB (dev only, no migration files).

## Do

- Use `eq`, `and`, `or`, `inArray`, `like`, `desc`, `asc` from `drizzle-orm` for predicates.
- Use `.returning()` after inserts/updates to get the new row back.
- Use `db.transaction(async (tx) => { ... })` for multi-statement writes.
- For relations, use `db.query.users.findMany({ with: { todos: true } })` (requires `schema` passed to `drizzle()`).

## Don't

- Don't construct SQL strings by hand for user input — use Drizzle's `sql` template tag (parameterized) or query builders.
- Don't call `pool.end()` between requests — keep the pool alive for the process lifetime.

## Examples

### CRUD

```ts
import { db } from "./db";
import { todos } from "./schema";
import { eq, and, desc } from "drizzle-orm";

// list
const list = await db.select().from(todos).where(eq(todos.userId, 1)).orderBy(desc(todos.id));

// insert + return
const [created] = await db.insert(todos).values({ userId: 1, text: "milk" }).returning();

// update
await db.update(todos).set({ done: true }).where(eq(todos.id, created.id));

// delete
await db.delete(todos).where(and(eq(todos.userId, 1), eq(todos.done, true)));
```

### Transaction

```ts
await db.transaction(async (tx) => {
  const [u] = await tx.insert(users).values({ email: "a@b.com" }).returning();
  await tx.insert(todos).values({ userId: u.id, text: "first" });
});
```

### Relational query

```ts
const result = await db.query.users.findFirst({
  where: (u, { eq }) => eq(u.email, "a@b.com"),
  with: { todos: { where: (t, { eq }) => eq(t.done, false) } },
});
```
