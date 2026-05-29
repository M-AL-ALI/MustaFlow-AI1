// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Ora → Builder handoff token store (in-memory)
//
// ARCHITECTURE LIMITATION (document per approved corrections):
//   - Tokens are LOST if the API server restarts (no persistence layer).
//   - Tokens will FAIL in multi-process deployments without sticky routing
//     because each process has its own Map — a token created on process A is
//     unknown to process B.
//   - Anonymous sign-up flows that take longer than 15 min TTL will see an
//     expired-token error; the user can start a new Ora session and try again.
//   - Future production scaling may require Redis, a DB-backed TTL table, or
//     another shared short-lived token store.
//
// In-memory is acceptable for Phase 6 (single-process Replit deployment):
//   - Tokens are short-lived (15 min) and single-use.
//   - Expired/used tokens produce a safe, actionable error message.
//   - No sensitive data is lost if the store is cleared — users simply retry.
// ─────────────────────────────────────────────────────────────────────────────

// TTL = 15 minutes: long enough to cover Clerk email-verification during
// anonymous sign-up (which typically takes 2–5 min but can take longer).
const TTL_MS = 15 * 60 * 1000;

const MAX_ENTRIES = 200;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface HandoffSummary {
  summary: string;
  appIdea: string;
  keyFeatures: string[];
  suggestedNextStep: string;
  source: "ora_public_handoff";
}

interface HandoffEntry {
  token: string;
  summary: HandoffSummary;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  sessionIdHash: string;
}

const store = new Map<string, HandoffEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt <= now || entry.consumed) store.delete(token);
  }
}, CLEANUP_INTERVAL_MS).unref();

function evictOldest(): void {
  let oldest: string | null = null;
  let oldestTime = Infinity;
  for (const [token, entry] of store.entries()) {
    if (entry.createdAt < oldestTime) {
      oldestTime = entry.createdAt;
      oldest = token;
    }
  }
  if (oldest) store.delete(oldest);
}

export function storeHandoff(
  summary: HandoffSummary,
  sessionIdHash: string,
): { token: string; expiresAt: number } {
  const now = Date.now();
  // Evict expired/consumed first
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt <= now || entry.consumed) store.delete(token);
  }
  // Evict oldest to stay within cap
  while (store.size >= MAX_ENTRIES) evictOldest();

  const token = crypto.randomUUID();
  const expiresAt = now + TTL_MS;
  store.set(token, { token, summary, createdAt: now, expiresAt, consumed: false, sessionIdHash });
  return { token, expiresAt };
}

export type ExchangeResult =
  | { ok: true; summary: HandoffSummary }
  | {
      ok: false;
      status: 404 | 410;
      error: string;
      reason: "not_found" | "expired" | "consumed";
    };

export function exchangeHandoff(token: string): ExchangeResult {
  const entry = store.get(token);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      error:
        "This handoff link was not found or has already expired. Please start a new conversation with Ora.",
      reason: "not_found",
    };
  }
  if (entry.expiresAt <= Date.now()) {
    store.delete(token);
    return {
      ok: false,
      status: 410,
      error:
        "This handoff link has expired (15-minute limit). Please start a new conversation with Ora.",
      reason: "expired",
    };
  }
  if (entry.consumed) {
    store.delete(token);
    return {
      ok: false,
      status: 410,
      error:
        "This handoff link has already been used. Please sign in and start a new project, or describe your idea directly.",
      reason: "consumed",
    };
  }

  // Single-use: mark consumed immediately before returning
  entry.consumed = true;

  return { ok: true, summary: entry.summary };
}

// ── Test helpers (not exported to consumers) ──────────────────────────────────
export function _handoffStoreSize(): number {
  return store.size;
}
export function _clearHandoffStore(): void {
  store.clear();
}
export function _insertExpiredEntry(token: string, summary: HandoffSummary): void {
  store.set(token, {
    token,
    summary,
    createdAt: Date.now() - TTL_MS - 1000,
    expiresAt: Date.now() - 1000,
    consumed: false,
    sessionIdHash: "test",
  });
}
