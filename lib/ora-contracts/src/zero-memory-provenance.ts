export const ZERO_MEMORY_PROVENANCE_SEMANTICS = "zero-memory-provenance-v1" as const;

export const ZERO_MEMORY_CLAIM_KINDS = ["stated", "observed", "inferred"] as const;

export type ZeroMemoryClaimKind = (typeof ZERO_MEMORY_CLAIM_KINDS)[number];

export type ZeroMemoryProvenanceSource = {
  messageStartId: number | null;
  messageEndId: number | null;
  taskId: number | null;
  versionId: number | null;
};

export type ZeroMemoryProvenance = {
  semantics: typeof ZERO_MEMORY_PROVENANCE_SEMANTICS;
  status: "verified" | "unverified";
  claimKind: ZeroMemoryClaimKind | null;
  label: "You said" | "A teammate said" | "Zero observed" | "Zero inferred" | "Source unverified";
  recordedAt: string | null;
  source: ZeroMemoryProvenanceSource | null;
};

export type ZeroMemoryProvenanceReceipt = {
  claimKind: unknown;
  actorUserId: string | null;
  sourceMessageStartId: number | null;
  sourceMessageEndId: number | null;
  sourceTaskId: number | null;
  sourceVersionId: number | null;
  createdAt: Date | string | null;
};

export function isZeroMemoryClaimKind(value: unknown): value is ZeroMemoryClaimKind {
  return (ZERO_MEMORY_CLAIM_KINDS as readonly unknown[]).includes(value);
}

function validPositiveIdentity(value: number | null): number | null {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : null;
}

function normalizedTimestamp(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Present one immutable memory receipt without leaking actor identities or
 * cross-project source identities. Historical rows are deliberately
 * unverified; provenance is never guessed from their content or type.
 */
export function presentZeroMemoryProvenance(
  receipt: ZeroMemoryProvenanceReceipt | null,
  context: { requestingUserId: string | null; maySeeSourceIdentities: boolean },
): ZeroMemoryProvenance {
  if (!receipt || !isZeroMemoryClaimKind(receipt.claimKind)) {
    return {
      semantics: ZERO_MEMORY_PROVENANCE_SEMANTICS,
      status: "unverified",
      claimKind: null,
      label: "Source unverified",
      recordedAt: null,
      source: null,
    };
  }

  const label =
    receipt.claimKind === "observed"
      ? "Zero observed"
      : receipt.claimKind === "inferred"
        ? "Zero inferred"
        : receipt.actorUserId !== null && receipt.actorUserId === context.requestingUserId
          ? "You said"
          : "A teammate said";

  return {
    semantics: ZERO_MEMORY_PROVENANCE_SEMANTICS,
    status: "verified",
    claimKind: receipt.claimKind,
    label,
    recordedAt: normalizedTimestamp(receipt.createdAt),
    source: context.maySeeSourceIdentities
      ? {
          messageStartId: validPositiveIdentity(receipt.sourceMessageStartId),
          messageEndId: validPositiveIdentity(receipt.sourceMessageEndId),
          taskId: validPositiveIdentity(receipt.sourceTaskId),
          versionId: validPositiveIdentity(receipt.sourceVersionId),
        }
      : null,
  };
}
