---
name: Orax Desktop Phase 2B schema
description: Lessons from implementing the full Phase 2B Orax Desktop DB schema — uniqueIndex conflict, Drizzle patch-type inference, enum collision.
---

## uniqueIndex on orax_paired_devices

The `orax_paired_devices` table needs `UNIQUE(host_id, mobile_device_id)`. In Drizzle:

```typescript
uniqueIndex("orax_paired_devices_host_mobile_uidx").on(t.hostId, t.mobileDeviceId)
```

Import `uniqueIndex` from `drizzle-orm/pg-core` (alongside `index`).

With this constraint, use `.onConflictDoUpdate({ target: [...], set: { lastSeenAt, revokedAt: null } })` in the redeem route — re-pairing a device should upsert (update lastSeenAt, clear revokedAt), not silently drop.

**Why:** Without the unique constraint, a phone pairing the same host twice creates duplicate rows. The unique index + upsert ensures one active pairing row per (host, device) pair.

## Drizzle $inferInsert patch-type inference

`Partial<typeof someTable.$inferInsert>` infers `{} | null` for fields on tables where any column has an SQL default (e.g. `id: text("id").default(sql\`gen_random_uuid()\`)`). TypeScript then rejects assignments of `string | undefined` to `{} | null`.

**Fix:** Use an explicit object type for patch variables:

```typescript
const patch: {
  deviceName?: string;
  permissionMode?: string;
  updatedAt: Date;
} = { updatedAt: new Date() };
```

Drizzle's `.set()` accepts a partial compatible object without caring about the full inferred type.

## Export name collision with orax.ts

`lib/db/src/schema/orax.ts` already exports `ORAX_APPROVAL_STATUSES` and `OraxApprovalStatus` for the existing ORAX task system. Adding the same names to `orax-desktop.ts` causes a TS2308 "already exported" error in `schema/index.ts`.

**Fix:** Prefix the desktop-specific variants: `ORAX_DESKTOP_APPROVAL_STATUSES` / `OraxDesktopApprovalStatus`.

**How to apply:** Before adding any new enum/type to an orax-* schema file, grep the other orax schema files for the same name.

## ZodRecord has no .passthrough()

`z.record(z.boolean()).passthrough()` is a TS error — `.passthrough()` only exists on `z.object()`, not `z.record()`. For a record that should accept any value, use `z.record(z.unknown())`.

## Wiring test schema file path

The wiring test lives at `artifacts/mustaflow/src/lib/__tests__/`. To reach `lib/db/src/schema/`:

```
../../../../../lib/db/src/schema/orax-desktop.ts
```

(Five `../` to get to the workspace root from `__tests__/`.)
