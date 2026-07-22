---
name: Ora release gate DB environment
description: Why the release gate fails with ECONNREFUSED 127.0.0.1:5432 off-Replit and how to diagnose it
---

The stability gate only falls back to a dummy `localhost:5432` DSN when `DATABASE_URL` is unset. A release-profile run failing every DB-touching check with `ECONNREFUSED 127.0.0.1:5432` is an environment problem, not a code regression.

**Why:** A Phase 1-7 "release gate blocked" investigation burned time on test code before finding the failing run had been executed outside Replit with no `DATABASE_URL`.

**How to apply:** Before debugging gate DB failures, check `DATABASE_URL` is set in the environment that ran the gate. Replit/Linux with the dev DB is the canonical gate environment; treat off-Replit gate results as advisory only.
