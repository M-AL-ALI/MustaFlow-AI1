import type { ProjectInput } from "@workspace/api-client-react";

export const BRIEF_LIMIT = 20000;
export const CREATION_KINDS = [
  "web",
  "fullstack",
  "dashboard",
  "automation",
  "api",
  "mobile-cross",
] as const;
export const CREATION_STACKS = [
  "react-vite",
  "nextjs",
  "node-api",
  "python-flask",
  "python-fastapi",
  "go-gin",
] as const;
export type CreationKind = (typeof CREATION_KINDS)[number];
export type CreationValues = {
  name: string;
  nameEdited: boolean;
  prompt: string;
  platform: "web" | "mobile";
  kind: CreationKind;
  stack: (typeof CREATION_STACKS)[number];
  appMode: "simple" | "fullstack";
  templateId: string | null;
};
export type ProjectReviewDraft = {
  id: string;
  ownerId: string;
  sourceDraftId: string | null;
  values: CreationValues;
  expiresAt: number;
};

const KEY = "nabuflow.project-review.v3";
const LEGACY_KEY = "nabuflow.project-review.v2";
const TTL = 30 * 60 * 1000;

function reviewKey(ownerId: string): string {
  return KEY + "." + encodeURIComponent(ownerId);
}

function legacyReviewKey(ownerId: string): string {
  return LEGACY_KEY + "." + encodeURIComponent(ownerId);
}

export function isCreationKind(value: string): value is CreationKind {
  return CREATION_KINDS.some((kind) => kind === value);
}

export function suggestProjectName(prompt: string): string {
  const subject = prompt
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:please\s+)?(?:build|create|make|design|develop)\s+(?:me\s+)?/i, "")
    .replace(/^(?:a|an|the)\s+/i, "");
  const words = subject
    .split(/[,.;!?]/)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80)
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Platform is represented by the server's existing kind field, never an extra payload field.
export function projectCreationInput(values: CreationValues, workspaceId?: number): ProjectInput {
  const prompt = values.prompt.trim();
  return {
    name: values.name.trim(),
    description: prompt || undefined,
    initialPrompt: prompt || undefined,
    workspaceId,
    kind:
      values.platform === "mobile"
        ? "mobile-cross"
        : values.kind === "mobile-cross"
          ? "web"
          : values.kind,
    stack: values.platform === "web" ? values.stack : undefined,
    builderMode:
      values.platform === "web" && values.appMode === "fullstack" ? "agentic" : "static-legacy",
  };
}

type ReviewEnvelope = {
  version: 1;
  ownerId: string;
  // Oldest to newest successful save; at most one record per workspace/recovery slot.
  records: ProjectReviewDraft[];
};

function isReviewWorkspaceId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/** A new-project action needs an explicit, validated workspace, not account-wide recovery. */
export function projectReviewDestination(workspaceId: unknown): string {
  return isReviewWorkspaceId(workspaceId)
    ? "/projects/new?reviewWorkspaceId=" + workspaceId
    : "/projects";
}

function reviewWorkspaceId(values: CreationValues): number | null {
  // Keep CreationValues unchanged: existing callers deliberately retain malformed IDs.
  const id: unknown = (values as CreationValues & { workspaceId?: unknown }).workspaceId;
  return isReviewWorkspaceId(id) ? id : null;
}

function isReviewDraft(
  draft: unknown,
  ownerId: string,
  now: number,
  includeExpired = false,
): draft is ProjectReviewDraft {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return false;
  const record = draft as Partial<ProjectReviewDraft>;
  const values = record.values;
  if (
    record.ownerId !== ownerId ||
    typeof record.id !== "string" ||
    !record.id ||
    (record.sourceDraftId !== null && typeof record.sourceDraftId !== "string") ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= 0 ||
    (!includeExpired && record.expiresAt <= now) ||
    record.expiresAt > now + TTL ||
    !values ||
    typeof values !== "object" ||
    typeof values.name !== "string" ||
    typeof values.nameEdited !== "boolean" ||
    typeof values.prompt !== "string" ||
    values.prompt.length > BRIEF_LIMIT ||
    (values.platform !== "web" && values.platform !== "mobile") ||
    typeof values.kind !== "string" ||
    !isCreationKind(values.kind) ||
    !CREATION_STACKS.some((stack) => stack === values.stack) ||
    (values.appMode !== "simple" && values.appMode !== "fullstack") ||
    (values.templateId !== null && typeof values.templateId !== "string")
  )
    return false;
  return true;
}

function readReviewRecords(
  ownerId: string,
  now: number,
  includeExpired = false,
): ProjectReviewDraft[] | null {
  // Storage access errors propagate: a failed read must never become an empty overwrite.
  // The old client owns v2. Never write its key: a rollback cannot destroy v3 reviews.
  // Once v3 exists (including an empty envelope), it is authoritative. Do not merge
  // older-client edits implicitly into a current workspace or revive consumed drafts.
  const current = sessionStorage.getItem(reviewKey(ownerId));
  const raw = current === null ? sessionStorage.getItem(legacyReviewKey(ownerId)) : current;
  if (!raw) return [];
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return []; // Preserve the existing ability to replace unreadable JSON on a later save.
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  if (!("version" in stored)) {
    return isReviewDraft(stored, ownerId, now, includeExpired) ? [stored] : [];
  }
  const envelope = stored as Partial<ReviewEnvelope>;
  if (envelope.version !== 1 || envelope.ownerId !== ownerId || !Array.isArray(envelope.records))
    return null; // Do not overwrite an unsupported or structurally ambiguous envelope.

  const records = envelope.records.filter((record) =>
    isReviewDraft(record, ownerId, now, includeExpired),
  );
  const ids = new Set<string>();
  const workspaces = new Set<number | null>();
  for (const record of records) {
    const workspaceId = reviewWorkspaceId(record.values);
    if (ids.has(record.id) || workspaces.has(workspaceId)) return null;
    ids.add(record.id);
    workspaces.add(workspaceId);
  }
  return records;
}

export function readProjectReviewDraft(
  ownerId: string,
  workspaceId?: number,
): ProjectReviewDraft | null {
  try {
    if (
      typeof ownerId !== "string" ||
      !ownerId.trim() ||
      (workspaceId !== undefined && !isReviewWorkspaceId(workspaceId))
    )
      return null;
    const records = readReviewRecords(ownerId, Date.now());
    if (!records) return null;
    return workspaceId === undefined
      ? (records[records.length - 1] ?? null)
      : (records.find((record) => reviewWorkspaceId(record.values) === workspaceId) ?? null);
  } catch {
    return null;
  }
}

export function saveProjectReviewDraft(
  ownerId: string,
  values: CreationValues,
  sourceDraftId: string | null,
  previousReceiptId?: string,
): ProjectReviewDraft | null {
  try {
    if (
      typeof ownerId !== "string" ||
      !ownerId.trim() ||
      (previousReceiptId !== undefined &&
        (typeof previousReceiptId !== "string" || !previousReceiptId))
    )
      return null;
    const now = Date.now();
    const draft: ProjectReviewDraft = {
      id: crypto.randomUUID(),
      ownerId,
      sourceDraftId,
      values,
      expiresAt: now + TTL,
    };
    if (!isReviewDraft(draft, ownerId, now)) return null;
    // A mounted form may still hold its exact receipt after the restoration TTL.
    // Inspect valid expired receipts for that fence, but never restore or retain
    // expired siblings as a side effect of saving the edited form.
    const storedRecords = readReviewRecords(ownerId, now, true);
    if (!storedRecords || storedRecords.some((record) => record.id === draft.id)) return null;
    const records = storedRecords.filter((record) => record.expiresAt > now);
    const workspaceId = reviewWorkspaceId(values);
    const target = records.find((record) => reviewWorkspaceId(record.values) === workspaceId);
    if (previousReceiptId !== undefined) {
      const previous = storedRecords.find((record) => record.id === previousReceiptId);
      // Reject stale receipts and occupied move destinations, preserving both reviews.
      if (!previous || (target && target.id !== previous.id)) return null;
    }
    const envelope: ReviewEnvelope = {
      version: 1,
      ownerId,
      records: [
        ...records.filter(
          (record) =>
            reviewWorkspaceId(record.values) !== workspaceId && record.id !== previousReceiptId,
        ),
        draft,
      ],
    };
    // One atomic replacement; never clear, evict live reviews, or retry with less data.
    sessionStorage.setItem(reviewKey(ownerId), JSON.stringify(envelope));
    return draft;
  } catch {
    return null;
  }
}

export function clearProjectReviewDraft(ownerId: string, id: string): void {
  try {
    if (typeof ownerId !== "string" || !ownerId.trim() || typeof id !== "string" || !id) return;
    const now = Date.now();
    // A late successful creation must consume its exact receipt even after expiry,
    // otherwise a still-mounted stale form could renew an already-consumed draft.
    const records = readReviewRecords(ownerId, now, true);
    if (!records || !records.some((record) => record.id === id)) return;
    const remaining = records.filter((record) => record.id !== id && record.expiresAt > now);
    // Retain an empty migration marker when legacy data remains. Removing v3 here
    // would make a successfully consumed legacy draft appear again on the next read.
    if (remaining.length || sessionStorage.getItem(legacyReviewKey(ownerId)) !== null) {
      const envelope: ReviewEnvelope = { version: 1, ownerId, records: remaining };
      sessionStorage.setItem(reviewKey(ownerId), JSON.stringify(envelope));
    } else {
      sessionStorage.removeItem(reviewKey(ownerId));
    }
  } catch {
    // The server has already created the project; storage must not block opening it.
  }
}
