---
name: Agent-loop foundation supervisor
description: Foundation-first check rule and hard-block supervisor in the agentic build loop.
---

typecheck+build checks are isFoundation:true. 5 consecutive failures force a check-blocked exit instead of endless retries. CHECK_META drives the targeted fix buttons shown to the user.

**Why:** without a hard block the agent loop burns budget retrying a build that cannot pass.
**How to apply:** new checks that gate everything else should be marked foundation; keep CHECK_META in sync when adding checks.
