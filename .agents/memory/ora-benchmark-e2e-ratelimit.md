---
name: Ora benchmark E2E rate-limiter bypass
description: oraLimiter concurrency gate must be bypassed for E2E benchmark requests; createExhaustedSession() shortcut for session-limit CTA tests.
---

# Ora benchmark E2E rate-limiter bypass

## The rule
`oraLimiter` in `lib/rateLimit.ts` has `ORA_MAX_CONCURRENT=2` and `ORA_MAX_QUEUED=3`. Any benchmark running with `CONCURRENCY≥3` will instantly 429 ("Ora is busy right now", 10ms) after the 5th concurrent slot fills. Add the E2E bypass at the TOP of `oraLimiter`:

```typescript
if (process.env.E2E_TEST_ENABLED === "true" && req.headers["x-e2e-test-user"]) {
  next();
  return;
}
```

**Why:** Without this, benchmark results are entirely invalid — 40/60 tests get instant 429 rejections from the rate limiter, not from the AI model. The pattern is identical to the session-creation limiter bypass already in `routes/public-ai/session.ts`.

## Session exhaustion shortcut (T49/T50)
`exhaustSession()` sends up to 20 sequential chat messages to hit the anon session message limit — `MSG_LIMIT=20` × ~10s each = 200s, always exceeding the 115s bash budget.

Fix: `createExhaustedSession()` in `lib/public-ai/session.ts` creates a JWT with `msgCount=MSG_LIMIT`. The session route accepts `x-e2e-exhaust: true` (E2E-gated) to call it. Benchmark uses `createPreExhaustedAnonSession()` instead of `exhaustSession()`.

**How to apply:** Whenever T49/T50 ("session limit CTA") tests are added to the benchmark, use `createPreExhaustedAnonSession()` — never the exhaustion loop.

## Benchmark score baseline (2026-06-17)
- Overall: **95.0%** | Target: 97% | Gap: -2.0%
- Gaps: Session Limit CTA 78% (T49/T50 missing upgradeCta fields), Model Identity 87% (T38-T39 naming providers), Standalone Scope 95% (T41 leaks Builder)
- Report: `docs/ora-benchmark-report.md`
