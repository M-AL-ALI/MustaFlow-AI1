---
name: prisma
description: Use Prisma ORM — schema-first models, type-safe Client, and migrations against any SQL DB.
triggers: [prisma, prisma client, prisma migrate]
---

# Prisma skill

Use when the user prefers a schema-first ORM. Prisma owns the schema (`prisma/schema.prisma`), generates a fully-typed client, and handles migrations.

## Install

```sh
npm install prisma --save-dev
npm install @prisma/client
npx prisma init --datasource-provider postgresql
```

## Schema

```prisma
// prisma/schema.prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  body      String
  published Boolean  @default(false)
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
}
```

## Client (singleton)

```ts
// src/prisma.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

(The singleton avoids exhausting DB connections during dev hot-reload.)

## Migrations

- `npx prisma migrate dev --name add_posts` — create + apply a migration in dev.
- `npx prisma migrate deploy` — apply pending migrations in prod.
- `npx prisma db push` — push schema without migration files (dev experimentation only).
- `npx prisma studio` — visual DB browser.

## Do

- Always use `select` or `include` deliberately — Prisma returns everything you ask for, but `include` can cascade into N+1 surprises.
- Use `prisma.$transaction([...])` (array of promises) for batch atomic writes.
- Use `onDelete: Cascade` (or `SetNull`) on relations — Prisma needs this declared in the schema.

## Don't

- Don't instantiate `new PrismaClient()` in request handlers — use a singleton.
- Don't forget `npx prisma generate` after schema changes (CI should run it).
- Don't run `db push` in production — use `migrate deploy`.

## Examples

### CRUD

```ts
import { prisma } from "./prisma";

const u = await prisma.user.create({ data: { email: "a@b.com", name: "Ada" } });
const list = await prisma.user.findMany({ where: { email: { endsWith: "@b.com" } } });
const withPosts = await prisma.user.findUnique({ where: { id: u.id }, include: { posts: true } });
await prisma.user.update({ where: { id: u.id }, data: { name: "Ada L." } });
await prisma.user.delete({ where: { id: u.id } });
```

### Nested write

```ts
await prisma.user.create({
  data: {
    email: "hi@x.com",
    posts: { create: [{ title: "First", body: "Hello" }] },
  },
  include: { posts: true },
});
```

### Transaction

```ts
await prisma.$transaction(async (tx) => {
  const u = await tx.user.create({ data: { email: "tx@x.com" } });
  await tx.post.create({ data: { authorId: u.id, title: "t", body: "b" } });
});
```
