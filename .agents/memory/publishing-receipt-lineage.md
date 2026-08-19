---
name: Publishing receipt lineage
description: How to bind a Replit-published production build to the exact source commit using generated Git receipt and ledger commits.
---

Treat the generated **Published your App** commit as the authoritative source-to-build receipt: it must be a zero-content child of the intended source commit, have the same tree, and carry `Replit-Commit-Deployment-Build-Id`. Confirm that the paired `refs/replit/agent-ledger` merge includes that receipt and repeats the same build ID before making any post-publish marker.

**Why:** The generic deployment-status API reports that a successful build is serving but does not expose enough lineage to prove which source tree produced it. The generated receipt and ledger provide immutable Git evidence for that binding.

**How to apply:** After a user-triggered publish, wait only long enough for the receipt to materialize. Check receipt parent, tree equality, content delta, trailer build ID, and ledger ancestry. Then separately confirm live health. Do not fabricate a separate deployment UUID when the receipt/ledger schema only records the build ID.