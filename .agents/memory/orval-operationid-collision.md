---
name: Orval operationId collision overwrites generated body schema
description: Duplicate operationIds across endpoints cause Orval to silently overwrite the generated Zod body schema and React Query hook — callers importing the overwritten schema get the wrong shape.
---

## The rule

Every endpoint in openapi.yaml **must** have a globally unique `operationId`. Orval uses the operationId to name the generated Zod schema (`{OperationId}Body`) and React Query hook (`use{OperationId}`). Two endpoints sharing an operationId cause the second to overwrite the first — both the Zod schema and the hook — with no error.

**Why:** When the Image Studio endpoint (`POST /images/generate`) was added with `operationId: generateImage` — the same id already used by `POST /projects/:id/generate-image` — Orval overwrote `GenerateImageBody` with the Image Studio schema (prompt/quality/aspectRatio…) instead of the legacy schema (prompt/size/savePath). The legacy `routes/images.ts` silently broke at runtime because TypeScript compiled against a stale generated snapshot.

**How to apply:**

- When adding a new endpoint, grep openapi.yaml for `operationId:` and confirm the new id is unique before running codegen.
- Name new operationIds after the operation, not the resource: `enqueueImageGeneration` vs `generateImage`, `generateProjectImage` vs `generateImage`.
- The generated body schema name is `{PascalCaseOperationId}Body`. If two endpoints would generate the same name, one will win silently — rename before codegen.
- After adding an endpoint, run codegen and check `git diff lib/api-zod lib/api-client-react` for unexpected removals — Zod constants disappearing is a sign of a collision.
