---
name: Ora isolation rule
description: Permanent rule — Ora must have zero AI Builder relationship. Enforced by ora-isolation.test.ts.
---

# Ora isolation — permanent rule

## The rule

Ora is a STANDALONE AI assistant. It must have **zero relationship** with the AI Builder product.

**Never reintroduce:**
- `handoffCta` — in any Ora type, API response field, or message schema (Zod or TypeScript)
- `builder_handoff` — in any `OraTool` type union or `ORA_TOOLS` registry
- `MustaFlow Builder` — in any Ora system prompt, support prompt, or UI text
- `Continue in Builder` — in any Ora UI component or hook
- `ready to build` — in any Ora UI component or hook  
- `open in builder` — as rendered/returned text (detection regex in `build-intent.ts` is allowed)
- Any call to `/api/public-ai/handoff/create` from Ora frontend
- Any call to `/api/builder/handoff/exchange` from Ora frontend
- `storeHandoff()` or `ORA_HANDOFF_ENABLED` in `handoff.ts`

**Why:** Ora's value proposition is as a neutral, standalone AI assistant. Embedding Builder handoffs creates a confusing product experience and undermines Ora's standalone identity. The rule is permanent and user-confirmed.

**How to apply:**
- When adding a new Ora chat feature, tool, or API response field — grep for the forbidden patterns before committing.
- When writing Ora system prompt additions — never reference Builder, AI Builder, or MustaFlow Builder.
- If `ora-isolation.test.ts` fails in CI, a forbidden pattern has been reintroduced — do not bypass the test.

## Allowed exceptions (do not remove these)

| File | Why allowed |
|---|---|
| `routes/public-ai/handoff.ts` | Permanently-disabled route file — always returns 410, no token generated |
| `__tests__/phase6.test.ts` | Disabled-route test proving POST → 410 |
| `__tests__/phase1.test.ts` | Uses `.not.toBe("builder_handoff")` to prove isolation |
| `lib/public-ai/handoff-store.ts` | Builder-side exchange store — Ora never imports or calls it |
| `components/ora/build-intent.ts` | Has `/open in builder/i` as a USER-INPUT detection regex; does not render this text |
| Code comments (`// ...`) | Lines explaining what Ora is NOT are allowed |

## Enforcement

`artifacts/api-server/src/routes/public-ai/__tests__/ora-isolation.test.ts` runs 11 tests:
- Scans all active Ora files (lib/public-ai, routes/public-ai, ora-*.ts routes, components/ora, ora-panel, ora-bubble, hooks, lib/ora-*, pages/ora*)
- Fails immediately if any forbidden pattern appears in a non-excluded file
- Checks specific structural invariants: handoff.ts returns 410, OraTool has no builder_handoff, OraMessage has no handoffCta, DB message schemas have no handoffCta
