export type CreationDraftScope = { accountId: string; workspaceId: number | null };
export type CreationDraftInput = {
  intent: "build" | "brainstorm";
  prompt: string;
  platform: "web" | "mobile";
};
export type CreationDraft = CreationDraftInput & {
  id: string;
  expiresAt: number;
  origin: "public-entry" | "authenticated";
  accountId: string | null;
  workspaceId: number | null;
};

// v1 mixed public and authenticated ideas without provenance. Never adopt it.
const KEY = "nabuflow.creation-drafts.v2";
const SCHEMA = "nabuflow.creation-drafts/v2";
const TTL = 30 * 60 * 1000;
type Ledger = { schema: typeof SCHEMA; public: unknown; owned: Record<string, unknown> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function accountIdValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function workspaceIdValid(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  );
}
function scopeValid(scope: unknown): scope is CreationDraftScope {
  return (
    record(scope) &&
    accountIdValid(scope.accountId) &&
    (scope.workspaceId === null || workspaceIdValid(scope.workspaceId))
  );
}
function scopeKey(scope: CreationDraftScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId]);
}
function validDraft(
  value: unknown,
  scope: CreationDraftScope | null,
  includeExpired = false,
): CreationDraft | null {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    (value.intent !== "build" && value.intent !== "brainstorm") ||
    (value.platform !== "web" && value.platform !== "mobile") ||
    typeof value.prompt !== "string" ||
    value.prompt.length > 20000 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    (!includeExpired && value.expiresAt <= Date.now()) ||
    value.expiresAt > Date.now() + TTL ||
    (value.origin !== "public-entry" && value.origin !== "authenticated")
  )
    return null;
  if (scope === null) {
    if (value.origin !== "public-entry" || value.accountId !== null || value.workspaceId !== null) {
      return null;
    }
  } else if (value.accountId !== scope.accountId || value.workspaceId !== scope.workspaceId) {
    return null;
  }
  return {
    id: value.id,
    intent: value.intent,
    prompt: value.prompt,
    platform: value.platform,
    expiresAt: value.expiresAt,
    origin: value.origin,
    accountId: scope?.accountId ?? null,
    workspaceId: scope?.workspaceId ?? null,
  };
}
function readLedger(): Ledger {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return { schema: SCHEMA, public: null, owned: {} };
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    value.schema !== SCHEMA ||
    !record(value.owned) ||
    !Object.prototype.hasOwnProperty.call(value, "public")
  ) {
    throw new Error("creation_draft_invalid_ledger");
  }
  return { schema: SCHEMA, public: value.public, owned: value.owned };
}
function ownedDraft(
  ledger: Ledger,
  scope: CreationDraftScope,
  includeExpired = false,
): CreationDraft | null {
  const key = scopeKey(scope);
  return Object.prototype.hasOwnProperty.call(ledger.owned, key)
    ? validDraft(ledger.owned[key], scope, includeExpired)
    : null;
}
function newDraft(
  input: CreationDraftInput,
  scope: CreationDraftScope | null,
): CreationDraft | null {
  if (
    !record(input) ||
    (input.intent !== "build" && input.intent !== "brainstorm") ||
    (input.platform !== "web" && input.platform !== "mobile") ||
    typeof input.prompt !== "string" ||
    input.prompt.length > 20000
  )
    return null;
  return {
    id: crypto.randomUUID(),
    intent: input.intent,
    prompt: scope === null ? input.prompt.trim() : input.prompt,
    platform: input.platform,
    expiresAt: Date.now() + TTL,
    origin: scope === null ? "public-entry" : "authenticated",
    accountId: scope?.accountId ?? null,
    workspaceId: scope?.workspaceId ?? null,
  };
}

/** Only the deliberate public entry surface creates unassigned public intent. */
export function savePublicCreationDraft(input: CreationDraftInput): CreationDraft | null {
  try {
    const draft = newDraft(input, null);
    if (!draft) return null;
    const ledger = readLedger();
    sessionStorage.setItem(KEY, JSON.stringify({ ...ledger, public: draft }));
    return draft;
  } catch {
    return null;
  }
}

/** There is deliberately no omitted-scope fallback to public or another account. */
export function readCreationDraft(scope: CreationDraftScope): CreationDraft | null {
  if (!scopeValid(scope)) return null;
  try {
    return ownedDraft(readLedger(), scope);
  } catch {
    return null;
  }
}

/** expectedId makes completion-style changes conditional on the exact saved receipt. */
export function saveCreationDraft(
  input: CreationDraftInput,
  scope: CreationDraftScope,
  expectedId?: string,
): CreationDraft | null {
  if (
    !scopeValid(scope) ||
    (expectedId !== undefined && (typeof expectedId !== "string" || !expectedId))
  )
    return null;
  try {
    const ledger = readLedger();
    if (expectedId !== undefined && ownedDraft(ledger, scope, true)?.id !== expectedId) return null;
    const draft = newDraft(input, scope);
    if (!draft) return null;
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        ...ledger,
        owned: { ...ledger.owned, [scopeKey(scope)]: draft },
      }),
    );
    return draft;
  } catch {
    return null;
  }
}

/**
 * Claim public intent to an account before showing it; assign its workspace only
 * after explicit selection. Source removal and destination ownership are one
 * sessionStorage write. A failed write must never expose the unclaimed content.
 */
export function claimCreationDraft(
  scope: CreationDraftScope,
  expectedId?: string,
): CreationDraft | null {
  if (
    !scopeValid(scope) ||
    (expectedId !== undefined && (typeof expectedId !== "string" || !expectedId))
  )
    return null;
  try {
    const ledger = readLedger();
    const publicDraft = validDraft(ledger.public, null);
    const unassignedScope = { accountId: scope.accountId, workspaceId: null };
    const unassigned = scope.workspaceId === null ? null : ownedDraft(ledger, unassignedScope);
    const source = publicDraft ?? unassigned ?? ownedDraft(ledger, scope);
    // A stale URL must not claim a different public idea, consume an account's
    // unassigned receipt, or overwrite a workspace destination before rejection.
    if (!source || (expectedId !== undefined && source.id !== expectedId)) return null;
    if (!publicDraft && !unassigned) return source;
    const claimed: CreationDraft = { ...source, ...scope };
    const owned = { ...ledger.owned, [scopeKey(scope)]: claimed };
    if (!publicDraft && unassigned) delete owned[scopeKey(unassignedScope)];
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        ...ledger,
        public: publicDraft ? null : ledger.public,
        owned,
      }),
    );
    return claimed;
  } catch {
    return null;
  }
}

export function creationDraftDestination(scope: CreationDraftScope): string {
  const draft = readCreationDraft(scope);
  if (draft?.intent !== "build") return "/projects";
  const params = new URLSearchParams({ draft: "1", draftId: draft.id });
  if (draft.workspaceId !== null) params.set("workspaceId", String(draft.workspaceId));
  return "/projects/new?" + params.toString();
}

/** An old completion may clear only its exact receipt within its exact scope. */
export function clearCreationDraft(id: string, scope: CreationDraftScope): void {
  if (!scopeValid(scope) || typeof id !== "string" || !id) return;
  try {
    const ledger = readLedger();
    // Expiry prevents display/admission, not identity-checked reclamation.
    if (ownedDraft(ledger, scope, true)?.id !== id) return;
    const owned = { ...ledger.owned };
    delete owned[scopeKey(scope)];
    sessionStorage.setItem(KEY, JSON.stringify({ ...ledger, owned }));
  } catch {
    // A failed cleanup never broadens its scope or undoes successful creation.
  }
}
