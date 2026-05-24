---
name: supabase
description: Use Supabase for Postgres + Auth + Storage with the supabase-js client and Row Level Security.
triggers: [supabase, supabase-js, rls]
---

# Supabase skill

Use when the user wants a hosted Postgres with auth + storage out of the box. Supabase = Postgres + GoTrue auth + S3-compatible storage + Realtime, all reachable from a single JS client.

## Install

```sh
npm install @supabase/supabase-js
```

## Client (browser)

```ts
// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!,
);
```

The **anon key** is safe to ship to browsers because Row Level Security (RLS) decides what each user can read. The **service role key** is server-only and bypasses RLS.

## Auth

```ts
// sign up / sign in
await supabase.auth.signUp({ email, password });
await supabase.auth.signInWithPassword({ email, password });
await supabase.auth.signOut();

// current user
const {
  data: { user },
} = await supabase.auth.getUser();

// subscribe to changes
supabase.auth.onAuthStateChange((event, session) => {
  /* ... */
});
```

## Queries

```ts
// select with filters
const { data, error } = await supabase
  .from("todos")
  .select("id, text, done")
  .eq("user_id", user.id)
  .order("id", { ascending: false });

// insert (returns inserted rows when .select() is chained)
const { data: created } = await supabase
  .from("todos")
  .insert({ user_id: user.id, text: "milk" })
  .select()
  .single();

// update
await supabase.from("todos").update({ done: true }).eq("id", created.id);

// delete
await supabase.from("todos").delete().eq("id", created.id);
```

## RLS — required for security

Without RLS, the anon key can read/write everything. **Enable RLS on every table**:

```sql
alter table public.todos enable row level security;

create policy "Users see own todos"
  on public.todos for select using (auth.uid() = user_id);

create policy "Users create own todos"
  on public.todos for insert with check (auth.uid() = user_id);

create policy "Users modify own todos"
  on public.todos for update using (auth.uid() = user_id);
```

## Storage

```ts
// upload
await supabase.storage.from("avatars").upload(`${user.id}.png`, file, { upsert: true });
// public URL (for a public bucket)
const { data } = supabase.storage.from("avatars").getPublicUrl(`${user.id}.png`);
```

## Don't

- Don't ship the service-role key to the browser — ever.
- Don't skip RLS — disabled RLS + anon key = open DB.
- Don't use `select("*")` in production code — list columns explicitly to avoid leaking new fields.

## Examples

### Realtime subscription

```ts
const ch = supabase
  .channel("public:todos")
  .on("postgres_changes", { event: "*", schema: "public", table: "todos" }, (payload) => {
    console.log("change", payload);
  })
  .subscribe();
// later: supabase.removeChannel(ch);
```

### Server-side with service role

```ts
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
```
