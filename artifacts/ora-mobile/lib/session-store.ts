/**
 * Module-level store for the Ora session that index.tsx holds.
 * Settings.tsx reads this to show the "local session tier" in Account Sync
 * without needing a shared React context.
 */
let _currentSessionTier: string | null = null;
let _currentSessionIsPaid = false;

export function setCurrentSessionTier(tier: string | null, isPaid = false): void {
  _currentSessionTier = tier;
  _currentSessionIsPaid = isPaid;
}

export function getCurrentSessionTier(): string | null {
  return _currentSessionTier;
}

export function getCurrentSessionIsPaid(): boolean {
  return _currentSessionIsPaid;
}
