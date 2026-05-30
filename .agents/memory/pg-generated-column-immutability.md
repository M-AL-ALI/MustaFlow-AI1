---
name: PostgreSQL generated column immutability
description: GENERATED ALWAYS AS STORED columns require fully IMMUTABLE expressions; common functions are not and cause silent-looking errors.
---

## The rule
PostgreSQL `GENERATED ALWAYS AS (...) STORED` rejects any expression that is not fully IMMUTABLE (all functions, operators, casts).

## What fails

- `array_to_string(anyarray, text)` — STABLE, not IMMUTABLE. Rejected in generated columns.
- Subqueries (SELECT inside USING) — rejected in both `ALTER TABLE ... USING` and generated column expressions.
- `to_tsvector('english', ...)` where config is a `text` literal — ambiguous volatility; use `::regconfig` cast.

## What works

- `to_tsvector('pg_catalog.english'::regconfig, text_expr)` — IMMUTABLE when config is cast to `regconfig`.
- `coalesce(col, '')` — IMMUTABLE for text columns.
- `||` text concat — IMMUTABLE.

## Preferred pattern: functional GIN index

When the tsvector expression includes STABLE functions (e.g. for array columns):

```sql
CREATE INDEX vault_entries_search_idx ON vault_entries
  USING GIN(
    to_tsvector('pg_catalog.english'::regconfig,
      coalesce(title, '') || ' ' || coalesce(summary, '')
    )
  );
```

Query must mirror the index expression exactly for the planner to use it:

```sql
WHERE to_tsvector('pg_catalog.english'::regconfig,
  coalesce(title, '') || ' ' || coalesce(summary, '')
) @@ plainto_tsquery('pg_catalog.english'::regconfig, $1)
```

**Why:** Functional indexes recompute at INSERT/UPDATE time and have no IMMUTABLE requirement. The planner matches the expression and uses the GIN index. Generated columns are cleaner but impractical when any part of the expression is STABLE.
