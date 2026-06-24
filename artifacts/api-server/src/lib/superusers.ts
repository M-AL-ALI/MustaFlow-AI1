// ─────────────────────────────────────────────────────────────────────────────
// Superuser allowlist — single source of truth (Task #1303)
//
// A small, hard-coded allowlist of email addresses that receive complete free
// full-access to the platform:
//   • treated as admin everywhere `requireAdmin` is enforced (see adminAuth.ts)
//   • unlimited usage with zero credit charges, regardless of CREDITS_ENFORCEMENT
//     (see credits.ts + the build/refine/image/EAS preflight gates)
//   • free switching between all workspace plan tiers with no Stripe payment
//     (see routes/billing.ts)
//
// The platform identifies users by Clerk user ID internally, so this module
// resolves the allowlisted email(s) → Clerk user ID(s) via the existing
// clerk-users helpers and caches the resolution for the process lifetime.
//
// NO other user's behavior changes. Managing this list dynamically is out of
// scope — it is intentionally hard-coded here.
// ─────────────────────────────────────────────────────────────────────────────

import { findClerkUserByEmail } from "./clerk-users";

// Ora treats the allowlisted owner as Core when no explicit paid Ora
// subscription row exists. Real Core/Wave subscriptions still take precedence.
export const SUPERUSER_ORA_TIER = "core";

// Case-insensitive email allowlist. Compared in lowercase.
const SUPERUSER_EMAILS: ReadonlyArray<string> = ["mus_192@yahoo.com"].map((e) =>
  e.trim().toLowerCase(),
);

// Clerk user IDs resolved from SUPERUSER_EMAILS. Populated lazily and cached
// for the process lifetime once successfully resolved.
const resolvedIds = new Set<string>();

// Avoid hammering Clerk: once every email has resolved we never look up again.
// If resolution is incomplete (Clerk not configured at boot, transient error),
// re-attempt at most once per RETRY_INTERVAL_MS.
const RETRY_INTERVAL_MS = 60_000;
let lastResolveAt = 0;
let resolving: Promise<void> | null = null;

async function ensureResolved(): Promise<void> {
  if (resolvedIds.size >= SUPERUSER_EMAILS.length) return;
  if (resolving) return resolving;
  if (lastResolveAt !== 0 && Date.now() - lastResolveAt < RETRY_INTERVAL_MS) return;

  resolving = (async () => {
    lastResolveAt = Date.now();
    for (const email of SUPERUSER_EMAILS) {
      try {
        const user = await findClerkUserByEmail(email);
        if (user?.userId) resolvedIds.add(user.userId);
      } catch {
        // Swallow — degrade gracefully like the rest of clerk-users.
      }
    }
  })().finally(() => {
    resolving = null;
  });

  return resolving;
}

/**
 * Async check: is this Clerk user ID a superuser? Resolves the email allowlist
 * to user IDs on first call (cached afterwards). Returns false for unknown or
 * empty IDs, and when Clerk is not configured / the user does not exist.
 */
export async function isSuperuser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  if (resolvedIds.has(userId)) return true;
  await ensureResolved();
  return resolvedIds.has(userId);
}

/**
 * Synchronous check for hot paths. Only returns true once the ID has already
 * been resolved (e.g. by a prior isSuperuser call). Never triggers a Clerk
 * lookup. Prefer the async variant unless you are certain resolution ran.
 */
export function isSuperuserSync(userId: string | null | undefined): boolean {
  return !!userId && resolvedIds.has(userId);
}

/** Test/diagnostic helper — the configured allowlist emails (lowercased). */
export function superuserEmails(): ReadonlyArray<string> {
  return SUPERUSER_EMAILS;
}
