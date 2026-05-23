---
name: postgres-drizzle
description: Model and query Postgres data with Drizzle ORM in TypeScript.
triggers: [database, db, schema, table, sql, postgres, postgresql, drizzle, migration, query, orm]
---

# Postgres + Drizzle skill

Use this whenever the user needs to persist data: a CRUD app, a dashboard
backed by a DB, anything that says "save", "store", "history", or "users".

## Required secret

- `DATABASE_URL` — a Postgres connection string (e.g. `postgres://user:pass@host:5432/db`).

## Project layout

```
src/db/
  client.ts      # pool + drizzle() instance
  schema/
    index.ts     # re-exports every table
    users.ts
    posts.ts
```

## Client

```ts
// src/db/client.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

## Schema

```ts
// src/db/schema/users.ts
import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_created_at_idx").on(t.createdAt)],
);

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
```

## Queries

```ts
import { eq, desc, and, isNull } from "drizzle-orm";

// SELECT
const recent = await db
  .select()
  .from(usersTable)
  .where(and(eq(usersTable.email, email), isNull(usersTable.deletedAt)))
  .orderBy(desc(usersTable.createdAt))
  .limit(20);

// INSERT (with returning)
const [created] = await db.insert(usersTable).values({ email, name }).returning();

// UPDATE
await db.update(usersTable).set({ name }).where(eq(usersTable.id, id));

// Bulk insert — one round-trip
await db.insert(postsTable).values(rows);
```

## Do

- Always use parameterised query builders (`eq`, `and`, `inArray`). Never string-concat user input into SQL.
- Add an index for every column you filter or sort by frequently.
- Use `timestamptz` (`withTimezone: true`) for every timestamp.
- Use `serial` or `uuid` primary keys — never trust client-supplied IDs.
- Soft-delete with a `deleted_at timestamptz` column when records may need recovery, and filter every query with `isNull(table.deletedAt)`.
- Wrap multi-statement writes in `db.transaction(async (tx) => { ... })`.

## Don't

- No raw `pool.query("SELECT * FROM users WHERE id = " + id)` — that's a SQL injection.
- Don't run schema migrations from app startup in production. Use a separate migration script.
- Don't return password hashes, tokens, or PII from API responses. Select only the columns you need.
- Don't `SELECT *` in hot paths — list columns explicitly.
- Don't keep a long-lived connection per request; reuse the `pool`.
