/**
 * auth-state-context — lightweight auth state shared across the app tree.
 *
 * Provides a single `{ isSignedIn: boolean }` value that works whether the
 * current entry is the full authenticated app (Clerk-backed) or the
 * lightweight public entry (always false — no ClerkProvider).
 *
 * Usage:
 *   const { isSignedIn } = useAuthState();
 *
 * In App.tsx the value is bridged from Clerk's useAuth() via
 * ClerkAuthStateBridge. In PublicApp.tsx it is always `{ isSignedIn: false }`.
 */

import { createContext, useContext, type ReactNode } from "react";

interface AuthState {
  isSignedIn: boolean;
}

const AuthStateContext = createContext<AuthState>({ isSignedIn: false });

export function useAuthState(): AuthState {
  return useContext(AuthStateContext);
}

export function AuthStateProvider({
  children,
  isSignedIn,
}: {
  children: ReactNode;
  isSignedIn: boolean;
}) {
  return <AuthStateContext.Provider value={{ isSignedIn }}>{children}</AuthStateContext.Provider>;
}
