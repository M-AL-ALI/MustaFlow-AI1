---
name: Zod parse on GET responses
description: GET handlers must use safeParse with a raw fallback.
---

Using `.parse()` (not `.safeParse()`) in GET handlers causes a 500 if ANY DB row has an unexpected field type — one bad legacy row breaks the whole list.

**How to apply:** GET/list handlers validate with safeParse and fall back to the raw row (or skip the row) instead of throwing.
