---
name: Ora spend ledger design
description: Wave 1C durable spend-cap ledger — DB schema, init pattern, test injection, and alert thresholds.
---

## Rule

`ora_spend_ledger` table backs the in-memory spend caps with restart-safe DB persistence. One row per `(date_key, ledger_key)`, upserted atomically via `ON CONFLICT DO UPDATE`.

**How to apply:**
- `initSpendLedger(pool)` must be called at server startup AFTER startup migrations so the table exists.
- `_setLedgerPool(pool | null)` is the test injection point — the 40+ existing sync tests never call it and therefore never touch the DB.
- DB persistence is fire-and-forget (`void persistSpendToDB(...)`) — never blocks the request path.
- `_ledgerInitialized` gate: if `false`, persistence is a no-op; guards the existing test suite from needing a mock DB.
- Alert thresholds at 50%/80%/95%/100% emit `ora_spend_cap_threshold` structured warn events only on crossing (`prev < cutoff <= next`), never on repeated calls within the same band.
- The standalone `lint` workflow may show "failed" from a stale run; the quality-gate's inline `lint` step is the canonical verdict.

**Why:** Server restarts were resetting in-memory counters to zero, allowing burst spend above the daily cap. DB upserts are atomic per-row so no cross-restart double-count occurs.
