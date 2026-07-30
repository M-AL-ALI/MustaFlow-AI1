---
name: NabuFlow billing core invariants
description: Durable rules for the NabuFlow Builder plan family — gate/ladder semantics, cycle accounting, config units, bypass ordering.
---

# NabuFlow billing core invariants

- **Ladder is access-only.** Per-tier Pro/Deep limits and the Pro+Deep combo gate what may START; charge points and amounts stay byte-identical to `creditCostFor`. Never let a ladder change touch pricing.
  **Why:** product rule from the billing-core build; tests pin exact charge amounts.
  **How to apply:** new tiers/modes = config change in the plans module only; call sites read the config.

- **Counters at reserve, `skipUsageChecks` at drain.** Background/queued builds consume Pro/Deep counters + credits when RESERVED; the drain-time re-check passes `skipUsageChecks: true` so plan/card/pause are still enforced but usage isn't double-counted. In-flight builds are never killed by cap or counter enforcement — build-start only.
  **Why:** double-counting at drain overshot limits; killing mid-run violates the never-kill rule.

- **Config speaks DOLLARS, API speaks CENTS.** Plans config fields like `defaultSpendCapUsd`/`maxSpendCapUsd` are dollars; routes/DB convert ×100. Mixing these silently mis-caps by 100×.
  **How to apply:** any new money field: name it `...Usd` in config, `...UsdCents` in DB/API, convert at the route boundary.

- **Allowlist bypass degrades CLOSED.** A Clerk lookup failure must return not-exempt (no free builds on an outage). Billing allowlist deliberately ignores `BUILDER_OPEN_TO_ALL` — access-opening flags must never become billing exemptions. Bypass order: enforcement-off → test-bypass (dev-only, dead in prod via module-load const) → superuser → allowlist.

- **Testing the prod-kills-bypass guarantee:** `IS_PRODUCTION` is a module-load const, so the test needs `vi.resetModules()` + env set + fresh dynamic `import()`; top-level bindings from before the reset keep working for later tests.

- **Gate evaluator is pure; resolver does IO.** `evaluateNabuflowGate(state, request, now)` is fully unit-testable with hand-built state; keep new billing rules inside it (not sprinkled in routes) so the enforcement-flip matrix stays testable.
