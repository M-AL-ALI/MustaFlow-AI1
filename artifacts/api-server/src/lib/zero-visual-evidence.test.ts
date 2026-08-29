import { describe, expect, it } from "vitest";
import {
  checkZeroVisualEvidence,
  pendingZeroVisualEvidencePairs,
  recordZeroVisualEvidence,
  sameVisualEvidenceGeometry,
  type ZeroVisualEvidenceGeometry,
  type ZeroVisualEvidenceState,
} from "./zero-visual-evidence";

const region: ZeroVisualEvidenceGeometry = {
  url: "https://preview.example.test/dashboard",
  width: 1280,
  height: 800,
  fullPage: false,
  clip: { x: 20, y: 30, width: 600, height: 320 },
};

describe("zero visual evidence pairs", () => {
  it("requires a named pair for before and after evidence", () => {
    expect(
      checkZeroVisualEvidence({}, { phase: "before", pairId: null, geometry: region }),
    ).toEqual({ ok: false, code: "visual_evidence_pair_id_required" });
    expect(
      checkZeroVisualEvidence({}, { phase: "evidence", pairId: null, geometry: region }),
    ).toEqual({ ok: true });
  });

  it("accepts an after image only for the exact same route, viewport, and region", () => {
    const before = recordZeroVisualEvidence(
      {},
      { phase: "before", pairId: "hero-change", geometry: region },
      41,
    );
    expect(
      checkZeroVisualEvidence(before, {
        phase: "after",
        pairId: "hero-change",
        geometry: region,
      }),
    ).toEqual({ ok: true });
    expect(
      checkZeroVisualEvidence(before, {
        phase: "after",
        pairId: "hero-change",
        geometry: { ...region, width: 1024 },
      }),
    ).toEqual({ ok: false, code: "visual_evidence_geometry_mismatch" });
    expect(sameVisualEvidenceGeometry(region, { ...region, clip: { ...region.clip! } })).toBe(true);
  });

  it("does not permit missing, duplicate, or reused pairs", () => {
    const before = recordZeroVisualEvidence(
      {},
      { phase: "before", pairId: "card-change", geometry: region },
      51,
    );
    expect(
      checkZeroVisualEvidence(before, {
        phase: "before",
        pairId: "card-change",
        geometry: region,
      }),
    ).toEqual({ ok: false, code: "visual_evidence_pair_duplicate" });
    expect(
      checkZeroVisualEvidence({}, { phase: "after", pairId: "missing", geometry: region }),
    ).toEqual({ ok: false, code: "visual_evidence_before_missing" });
    const complete = recordZeroVisualEvidence(
      before,
      { phase: "after", pairId: "card-change", geometry: region },
      52,
    );
    expect(
      checkZeroVisualEvidence(complete, {
        phase: "after",
        pairId: "card-change",
        geometry: region,
      }),
    ).toEqual({ ok: false, code: "visual_evidence_pair_complete" });
  });

  it("reports pending pairs in deterministic order and leaves inputs untouched", () => {
    const initial: ZeroVisualEvidenceState = {};
    const zeta = recordZeroVisualEvidence(
      initial,
      { phase: "before", pairId: "zeta", geometry: region },
      61,
    );
    const both = recordZeroVisualEvidence(
      zeta,
      { phase: "before", pairId: "alpha", geometry: region },
      62,
    );
    expect(initial).toEqual({});
    expect(pendingZeroVisualEvidencePairs(both)).toEqual(["alpha", "zeta"]);
    const complete = recordZeroVisualEvidence(
      both,
      { phase: "after", pairId: "alpha", geometry: region },
      63,
    );
    expect(pendingZeroVisualEvidencePairs(complete)).toEqual(["zeta"]);
  });
});
