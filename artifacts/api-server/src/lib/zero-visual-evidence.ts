export type ZeroVisualEvidencePhase = "before" | "after" | "evidence";

export type ZeroVisualEvidenceGeometry = {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  clip: { x: number; y: number; width: number; height: number } | null;
};

export type ZeroVisualEvidencePair = {
  geometry: ZeroVisualEvidenceGeometry;
  beforeAssetId: number;
  afterAssetId: number | null;
};

export type ZeroVisualEvidenceState = Readonly<Record<string, ZeroVisualEvidencePair>>;

export type ZeroVisualEvidenceErrorCode =
  | "visual_evidence_pair_id_required"
  | "visual_evidence_pair_duplicate"
  | "visual_evidence_before_missing"
  | "visual_evidence_geometry_mismatch"
  | "visual_evidence_pair_complete";

export type ZeroVisualEvidenceInput = {
  phase: ZeroVisualEvidencePhase;
  pairId: string | null;
  geometry: ZeroVisualEvidenceGeometry;
};

export type ZeroVisualEvidenceCheck =
  | { ok: true }
  | { ok: false; code: ZeroVisualEvidenceErrorCode };

function sameClip(
  left: ZeroVisualEvidenceGeometry["clip"],
  right: ZeroVisualEvidenceGeometry["clip"],
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function sameVisualEvidenceGeometry(
  left: ZeroVisualEvidenceGeometry,
  right: ZeroVisualEvidenceGeometry,
): boolean {
  return (
    left.url === right.url &&
    left.width === right.width &&
    left.height === right.height &&
    left.fullPage === right.fullPage &&
    sameClip(left.clip, right.clip)
  );
}

export function checkZeroVisualEvidence(
  state: ZeroVisualEvidenceState,
  input: ZeroVisualEvidenceInput,
): ZeroVisualEvidenceCheck {
  if (input.phase === "evidence") return { ok: true };
  if (!input.pairId) return { ok: false, code: "visual_evidence_pair_id_required" };
  const existing = state[input.pairId];
  if (input.phase === "before") {
    return existing ? { ok: false, code: "visual_evidence_pair_duplicate" } : { ok: true };
  }
  if (!existing) return { ok: false, code: "visual_evidence_before_missing" };
  if (existing.afterAssetId !== null) {
    return { ok: false, code: "visual_evidence_pair_complete" };
  }
  if (!sameVisualEvidenceGeometry(existing.geometry, input.geometry)) {
    return { ok: false, code: "visual_evidence_geometry_mismatch" };
  }
  return { ok: true };
}

export function recordZeroVisualEvidence(
  state: ZeroVisualEvidenceState,
  input: ZeroVisualEvidenceInput,
  assetId: number,
): ZeroVisualEvidenceState {
  if (input.phase === "evidence" || !input.pairId) return state;
  if (input.phase === "before") {
    return {
      ...state,
      [input.pairId]: {
        geometry: input.geometry,
        beforeAssetId: assetId,
        afterAssetId: null,
      },
    };
  }
  const existing = state[input.pairId];
  if (!existing) return state;
  return {
    ...state,
    [input.pairId]: { ...existing, afterAssetId: assetId },
  };
}

export function pendingZeroVisualEvidencePairs(state: ZeroVisualEvidenceState): string[] {
  return Object.entries(state)
    .filter(([, pair]) => pair.afterAssetId === null)
    .map(([pairId]) => pairId)
    .sort();
}
