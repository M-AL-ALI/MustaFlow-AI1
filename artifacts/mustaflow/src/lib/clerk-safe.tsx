/**
 * clerk-safe — context-based wrappers for Clerk hooks.
 *
 * Problem: ClerkProvider is intentionally omitted from the tree in E2E dev-test
 * mode so that Clerk JS never tries to load from clerk.com (which fails in
 * Playwright's sandboxed browser, causing a Vite error overlay).
 * Any component that calls useUser() or useClerk() directly would throw
 * "can only be used within <ClerkProvider />" in that scenario.
 *
 * Solution: thin React-context wrappers that:
 *  - In normal mode: ClerkUserProvider / ClerkActionsProvider call the real
 *    Clerk hooks (safely inside ClerkProvider) and publish the values.
 *  - In E2E dev mode: providers are not mounted; components fall back to the
 *    mock defaults baked into the context (isSignedIn=true, stub user).
 *
 * Usage:
 *   - Replace `useUser()` with `useClerkUser()`
 *   - Replace `const { signOut } = useClerk()` with `useClerkActions()`
 *   - Mount <ClerkUserProvider> and <ClerkActionsProvider> inside ClerkProvider
 *     (AppShellBody does this when isE2E=false).
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useUser, useClerk } from "@clerk/react";

// ── Types ─────────────────────────────────────────────────────────────────────

type UseUserReturn = ReturnType<typeof useUser>;

type ClerkActions = {
  signOut: ReturnType<typeof useClerk>["signOut"];
  openUserProfile: ReturnType<typeof useClerk>["openUserProfile"];
};

// ── Mock defaults (used when no provider is in the tree) ──────────────────────

const mockUser = {
  id: "e2e-test-user",
  fullName: "E2E Test User",
  firstName: "E2E",
  lastName: "Test User",
  username: "e2e",
  emailAddresses: [{ emailAddress: "e2e@test.local", id: "e2e-email" }],
  primaryEmailAddress: { emailAddress: "e2e@test.local" },
  imageUrl: "",
} as unknown as NonNullable<UseUserReturn["user"]>;

const mockUseUserReturn: UseUserReturn = {
  isLoaded: true,
  isSignedIn: true,
  user: mockUser,
};

const mockClerkActions = {
  signOut: () => Promise.resolve(),
  openUserProfile: () => {},
} as unknown as ClerkActions;

// ── ClerkUser context ─────────────────────────────────────────────────────────

const ClerkUserCtx = createContext<UseUserReturn>(mockUseUserReturn);

/** Call inside ClerkProvider to publish real Clerk user state. */
export function ClerkUserProvider({ children }: { children: ReactNode }) {
  const clerkUser = useUser();
  return <ClerkUserCtx.Provider value={clerkUser}>{children}</ClerkUserCtx.Provider>;
}

/** Drop-in replacement for useUser(). Safe when ClerkProvider is absent (E2E). */
export function useClerkUser(): UseUserReturn {
  return useContext(ClerkUserCtx);
}

// ── ClerkActions context ──────────────────────────────────────────────────────

const ClerkActionsCtx = createContext<ClerkActions>(mockClerkActions);

/** Call inside ClerkProvider to publish real Clerk actions. */
export function ClerkActionsProvider({ children }: { children: ReactNode }) {
  const clerk = useClerk();
  const value = {
    signOut: clerk.signOut.bind(clerk),
    openUserProfile: clerk.openUserProfile.bind(clerk),
  } as unknown as ClerkActions;
  return <ClerkActionsCtx.Provider value={value}>{children}</ClerkActionsCtx.Provider>;
}

/** Safe accessor for signOut / openUserProfile. No-ops when ClerkProvider absent (E2E). */
export function useClerkActions(): ClerkActions {
  return useContext(ClerkActionsCtx);
}
