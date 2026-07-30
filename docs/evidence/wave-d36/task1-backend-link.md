# Wave D.3.6 Task 1 — report-side recovery link

## Root cause

The worker was not losing `report.architectReview` during its final write. It
builds the architect review, queues the auto-fix, assigns
`report.architectReview.autoFixTaskId`, and then persists the final report.

The field disappeared at the HTTP response boundary:

1. `GET /api/projects/:id/tasks` loads the complete JSON report from
   `agent_tasks`.
2. The route passes the rows through `ListTasksResponse.safeParse()`.
3. OpenAPI declared `report.additionalProperties: true`, but did not explicitly
   describe `architectReview`.
4. Orval generated a TypeScript index signature, but its Zod
   `z.object({...})` still stripped unknown properties on successful parsing.
5. The route returned `parsed.data`, so production clients received a report
   with `architectReview` removed.

This was reproduced before regeneration:

```text
architect-auto-fix-link.test.ts
1 failed | 3 passed

Expected report.architectReview.autoFixTaskId: 148
Received report with architectReview removed
```

After adding the property to the OpenAPI source and regenerating, the same
four-test suite passes.

## Persistence hardening

When an architect auto-fix is queued, the worker now also performs an atomic
JSONB update:

```sql
report = jsonb_set(
  COALESCE(report, '{}'::jsonb),
  '{architectReview}',
  $2::jsonb,
  true
)
```

Only the existing `architectReview` key is updated. Other report keys are
preserved. This also covers late-queue ordering where a base report was already
written before the recovery task id became available.

No task queue conditions, billing behavior, columns, migrations, endpoints, or
event schemas changed.

## Verification

```text
Pre-codegen regression: 1 failed | 3 passed (field stripped)
Post-codegen regression: 4 passed
API TypeScript: passed
Library TypeScript from codegen: passed

Second codegen diff hash:
before=25c06d732afd42ab4c4f7c1131860adb18416329
after=25c06d732afd42ab4c4f7c1131860adb18416329
second-codegen-drift=clean
```
