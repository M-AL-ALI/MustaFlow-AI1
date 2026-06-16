---
name: Ora response quality runtime lever
description: Where Ora's answer quality is actually enforced at runtime vs the test-only scorer.
---

Ora's runtime answer quality — specificity, structure, domain expertise, fewer generic openers — is driven by two things only:

- `prompt.ts` `ORA_SYSTEM_PROMPT` (base behavior, e.g. the "Answer specificity" section).
- `expertise.ts` `buildOraExpertiseProfile().systemAddendum`, injected per-request in BOTH chat.ts branches (conversational + search).

`response-quality.ts` `evaluateOraResponseQuality` is a TEST-ONLY quality gate. It is NOT called in the live request path; it only runs inside vitest to assert prompt/route behavior.

**Why:** It looks like the natural place to "improve answers," but the scorer has no runtime hook. Editing it changes nothing users see, and wiring it into a regenerate/retry loop was explicitly rejected during the Ora Answer Quality Upgrade.

**How to apply:** To change what users actually receive, edit `ORA_SYSTEM_PROMPT` or the expertise domain guidance. Touch `response-quality.ts` only to tighten the test gate. New expertise domains must be: added to the priority slice if regulated (the first `PRIORITY_DOMAIN_COUNT` entries beat classifier-topic routing), otherwise ordered earlier than any broader domain that shares its keywords (e.g. process_improvement before operations).
