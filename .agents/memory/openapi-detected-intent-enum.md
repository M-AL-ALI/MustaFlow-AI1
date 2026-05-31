---
name: ChatExchange detectedIntent enum must include every routing intent
description: Any new intent added to the messages.ts routing (image_generate, etc.) must also be added to ChatExchange.detectedIntent in openapi.yaml or the response serialization throws 500 after the job is already enqueued.
---

## Rule
`ChatExchange.detectedIntent` in `lib/api-spec/openapi.yaml` (around line 7167) must list every intent value that `POST /api/projects/:id/messages` can set on the response. Missing values cause a Zod parse error **after** the job is enqueued — the job runs successfully but the HTTP response returns 500.

**Why:** The response is validated against the generated Zod schema before being sent. `image_generate` was added to the routing logic but not to the OpenAPI enum, so every image-generation request returned 500 even though the image completed in the background.

**Current enum (as of Phase 9A-1 fix):**
```yaml
enum: [converse, plan, build, image_generate]
```

**How to apply:**
- Whenever a new `resolvedIntent` value is introduced in `messages.ts`, immediately add it to the `ChatExchange.detectedIntent` enum in `openapi.yaml`.
- Run `pnpm --filter @workspace/api-spec run codegen` after every openapi.yaml change.
- The generated Zod schema lives at `lib/api-zod/src/generated/api.ts` around line 1397.
