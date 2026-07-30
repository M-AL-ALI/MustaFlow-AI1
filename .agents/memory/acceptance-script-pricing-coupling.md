---
name: Acceptance script pricing coupling
description: verify-ladder.ts hardcodes expected overage amounts in cents; must be updated alongside rate changes.
---

When updating NabuFlow overage rates in nabuflow-plans.ts, the acceptance script
artifacts/api-server/acceptance/verify-ladder.ts (section F) contains hardcoded
expected cent amounts derived from those rates. After changing a plan's overageUsdPerCredit, update:
- The descriptive string (e.g. "100cr @ $0.012 = 120 cents")
- The numeric assertions (ovEvent?.overageUsdCents === 120, item.amount === 120)

**Why:** The acceptance scripts are tsx programs not Vitest tests, so TS type-check
does not catch stale numeric constants -- they silently fail at runtime.

**How to apply:** Any time overageUsdPerCredit is changed for a plan that section F
exercises (currently Orbit), grep verify-ladder.ts for the old cent amount and update
to credits x newRate x 100.
