---
name: Ora mobile session auth guard
description: /api/public-ai/session must be in pathRequiresAuth on mobile.
---

`/api/public-ai/session` MUST be listed in `pathRequiresAuth`. Omitting it silently creates anonymous sessions for signed-in users, producing a billing=Core but chat=Free mismatch.

**Why:** the session route decides tier; an anonymous session downgrades every subsequent chat call.
**How to apply:** any new authed Ora endpoint added to the mobile client must also be added to pathRequiresAuth (see ora-mobile-auth-stability-guard.md).
