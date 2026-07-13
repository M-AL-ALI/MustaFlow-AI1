---
name: Apple 5.1.1(v) in-app account deletion
description: An in-app "delete account" must delete the auth identity (Clerk user), not just app data, or the App Store rejects it.
---

## Rule
An in-app "Delete account" button that only soft-deletes app data (and schedules a
delayed hard-erasure) is NOT sufficient for App Store review. Reviewers test
delete-then-re-login; if sign-in still works it is a repeat 5.1.1(v) rejection. The
account-deletion route (DELETE /api/me, GDPR) must ALSO delete the auth identity:
`clerkClient.users.deleteUser(userId)`, wrapped by `deleteClerkUser()` in
`api-server/src/lib/clerk-users.ts`, so the sign-in credential is gone.

Ordering matters: do the Clerk email lookup for the confirmation email BEFORE
deleting the Clerk user (the address is unresolvable afterward). Return 200 even if
the Clerk delete fails (data soft-delete already committed) but log at error level
and expose `credentialsDeleted` in the response. Treat a Clerk 404 as success
(idempotent). `deleteClerkUser` degrades gracefully (returns false, never throws)
when CLERK_SECRET_KEY is unset.

The 30-day durable DB erasure job keys off the userId string and makes zero Clerk
calls, so it runs identically after the Clerk user is removed.

Mobile flow (settings.tsx): `await deleteAccount()` first; on failure show the error
and return. Only after success, `await signOut()` inside its own try/catch (the remote
session is already invalidated, so a signOut throw must NOT surface a false "Could not
delete account" alert), then `router.replace("/sign-in")`.

**Why:** Apple 5.1.1(v) requires deleting the whole account record; a working login
after "delete" fails review. GDPR Art. 17 delayed data erasure is a separate backend
concern on its own timeline.

**How to apply:** Any new in-app account-deletion surface (web or mobile) must reach a
route that deletes the auth identity, not just rows. Confirm-dialog copy
("permanently deletes… cannot be undone") is accurate once credentials are gone.
Non-blocking hardening idea: also call the idempotent `deleteClerkUser` inside the
30-day erasure worker so a transient Clerk failure still eventually removes creds.
