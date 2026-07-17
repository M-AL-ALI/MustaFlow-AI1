---
name: OpenAPI nullable vs typed-null
description: Mixed-type JSON fields must use nullable:true with no type constraint.
---

Fields storing mixed JSON types (array OR object) must use `nullable: true` with NO type constraint. `type: ["object","null"]` rejects arrays and causes Orval codegen to emit `record()`, which breaks at runtime.

**How to apply:** any OpenAPI field persisted as free-form JSON gets nullable-without-type; re-run codegen and check the generated Zod.
