import { describe, it, expect } from "vitest";
import { evaluatePublishGate, evaluatePromotionGate } from "../publish-gate";
import type {
  GateProject,
  GateSnapshotFile,
  GateSpecVersion,
  GatePromotionProject,
  GatePromotionVersion,
} from "../publish-gate";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SNAPSHOT: GateSnapshotFile[] = [
  { path: "index.html", content: "<html><body>hello</body></html>", mimeType: "text/html" },
  { path: "app.js", content: "console.log('hi')", mimeType: "application/javascript" },
];

const APPROVED_AT = new Date("2025-01-01T00:00:00Z");

function staticProject(overrides?: Partial<GateProject>): GateProject {
  return {
    builderMode: "agentic",
    testedSnapshotId: null,
    testingStatus: "idle",
    containerId: null,
    ...overrides,
  };
}

function fullStackProject(overrides?: Partial<GateProject>): GateProject {
  return {
    builderMode: "agentic",
    testedSnapshotId: null,
    testingStatus: "idle",
    containerId: "fly-machine-abc123",
    ...overrides,
  };
}

// ── CRITICAL RULE: no path that publishes from mutable project_files ──────────

describe("production without testedSnapshotId → 422 for ALL project types", () => {
  it("blocks static project with no testedSnapshotId", () => {
    const result = evaluatePublishGate(null, staticProject(), null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_required");
      expect(result.error).toContain("test preview");
    }
  });

  it("blocks full-stack project with no testedSnapshotId", () => {
    const result = evaluatePublishGate(null, fullStackProject(), null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_required");
      expect(result.error).toContain("Full-stack");
    }
  });
});

describe("production requires testingStatus === 'passed'", () => {
  it("blocks when testingStatus is 'stale' even if testedSnapshotId is set", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "stale" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: SNAPSHOT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_not_passed");
      expect(result.extra?.testingStatus).toBe("stale");
    }
  });

  it("blocks when testingStatus is 'failed'", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "failed" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: SNAPSHOT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("testing_not_passed");
    }
  });

  it("blocks when testingStatus is 'idle' (fresh project)", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "idle" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: SNAPSHOT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("testing_not_passed");
    }
  });
});

describe("production requires non-empty testedVersion snapshot", () => {
  it("blocks when testedVersion row is missing (null)", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "passed" });
    const result = evaluatePublishGate(null, project, null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("tested_snapshot_invalid");
      expect(result.extra?.testedSnapshotId).toBe(42);
    }
  });

  it("blocks when testedVersion filesSnapshot is empty array", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "passed" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tested_snapshot_invalid");
    }
  });

  it("blocks when testedVersion filesSnapshot is null", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "passed" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tested_snapshot_invalid");
    }
  });
});

describe("happy path — production allows with valid tested snapshot", () => {
  it("approves and returns the exact testedVersion snapshot (static)", () => {
    const project = staticProject({ testedSnapshotId: 42, testingStatus: "passed" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: SNAPSHOT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedSnapshot).toBe(SNAPSHOT);
      expect(result.approvedSnapshot).toHaveLength(2);
    }
  });

  it("approves and returns the exact testedVersion snapshot (full-stack)", () => {
    const project = fullStackProject({ testedSnapshotId: 99, testingStatus: "passed" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: SNAPSHOT });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedSnapshot).toBe(SNAPSHOT);
    }
  });
});

describe("late draft edit cannot reach production", () => {
  it("returns the approved snapshot, not any later draft", () => {
    const approvedSnapshot: GateSnapshotFile[] = [
      { path: "index.html", content: "<html>APPROVED</html>", mimeType: "text/html" },
    ];
    const draftSnapshot: GateSnapshotFile[] = [
      { path: "index.html", content: "<html>DRAFT_EDIT</html>", mimeType: "text/html" },
    ];

    const project = staticProject({ testedSnapshotId: 10, testingStatus: "passed" });
    // testedVersion carries the approved snapshot; draftSnapshot is never passed in
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: approvedSnapshot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The published output is the approved snapshot — never the draft
      expect(result.approvedSnapshot[0]?.content).toBe("<html>APPROVED</html>");
      expect(result.approvedSnapshot[0]?.content).not.toBe(draftSnapshot[0]?.content);
    }
  });
});

describe("explicit versionId path — gates ALL project types (not just agentic)", () => {
  it("blocks static project when versionId has no testingApprovedAt", () => {
    const project = staticProject({ builderMode: "agentic" });
    const specVersion: GateSpecVersion = { testingApprovedAt: null, filesSnapshot: SNAPSHOT };
    const result = evaluatePublishGate(7, project, specVersion, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_approval_required");
    }
  });

  it("blocks legacy static-legacy project when versionId has no testingApprovedAt", () => {
    const project = staticProject({ builderMode: "static-legacy" });
    const specVersion: GateSpecVersion = { testingApprovedAt: null, filesSnapshot: SNAPSHOT };
    const result = evaluatePublishGate(7, project, specVersion, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("testing_approval_required");
    }
  });

  it("blocks when versionId has testingApprovedAt but empty snapshot", () => {
    const project = staticProject();
    const specVersion: GateSpecVersion = { testingApprovedAt: APPROVED_AT, filesSnapshot: [] };
    const result = evaluatePublishGate(7, project, specVersion, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("approved_snapshot_empty");
    }
  });

  it("blocks when versionId not found (specVersion is null)", () => {
    const project = staticProject();
    const result = evaluatePublishGate(99, project, null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("version_not_found");
    }
  });

  it("allows and uses versionId snapshot when approved", () => {
    const project = staticProject();
    const specVersion: GateSpecVersion = {
      testingApprovedAt: APPROVED_AT,
      filesSnapshot: SNAPSHOT,
    };
    const result = evaluatePublishGate(7, project, specVersion, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedSnapshot).toBe(SNAPSHOT);
    }
  });
});

describe("production output equals testedSnapshotId.filesSnapshot", () => {
  it("the approvedSnapshot returned is reference-equal to what was passed in", () => {
    const frozen: GateSnapshotFile[] = [
      { path: "index.html", content: "<html>FROZEN</html>", mimeType: "text/html" },
    ];
    const project = staticProject({ testedSnapshotId: 5, testingStatus: "passed" });
    const result = evaluatePublishGate(null, project, null, { filesSnapshot: frozen });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Reference equality: the gate returns exactly what was in the DB row
      expect(result.approvedSnapshot).toBe(frozen);
    }
  });
});

// ── evaluatePromotionGate — staging → production promotion gate ───────────

const APPROVED_VERSION: GatePromotionVersion = {
  testingApprovedAt: new Date("2025-06-01T00:00:00Z"),
};

function promotionProject(overrides?: Partial<GatePromotionProject>): GatePromotionProject {
  return {
    testingStatus: "passed",
    testedSnapshotId: 7,
    stagingPublishedSnapshotId: 7,
    ...overrides,
  };
}

describe("evaluatePromotionGate — testingStatus must be passed", () => {
  it("blocks when testingStatus is idle", () => {
    const result = evaluatePromotionGate(
      promotionProject({ testingStatus: "idle" }),
      APPROVED_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_not_passed");
    }
  });

  it("blocks when testingStatus is stale", () => {
    const result = evaluatePromotionGate(
      promotionProject({ testingStatus: "stale" }),
      APPROVED_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("testing_not_passed");
      expect(result.extra?.testingStatus).toBe("stale");
    }
  });

  it("blocks when testingStatus is failed", () => {
    const result = evaluatePromotionGate(
      promotionProject({ testingStatus: "failed" }),
      APPROVED_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("testing_not_passed");
    }
  });
});

describe("evaluatePromotionGate — testedSnapshotId must be set", () => {
  it("blocks when testedSnapshotId is null even if testingStatus is passed", () => {
    const result = evaluatePromotionGate(
      promotionProject({ testedSnapshotId: null }),
      APPROVED_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_required");
    }
  });
});

describe("evaluatePromotionGate — testedSnapshotId must equal stagingPublishedSnapshotId", () => {
  it("blocks when staging snapshot differs from tested snapshot (mismatch)", () => {
    const result = evaluatePromotionGate(
      promotionProject({ testedSnapshotId: 7, stagingPublishedSnapshotId: 99 }),
      APPROVED_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("staging_snapshot_mismatch");
      expect(result.extra?.testedSnapshotId).toBe(7);
      expect(result.extra?.stagingPublishedSnapshotId).toBe(99);
    }
  });

  it("late draft edit: new staging snapshot after approval cannot promote", () => {
    // User approved snapshot 7 in Testing, then published a new draft to staging (snap 8).
    // Promoting snap 8 must be blocked — it was never tested.
    const result = evaluatePromotionGate(
      promotionProject({ testedSnapshotId: 7, stagingPublishedSnapshotId: 8 }),
      APPROVED_VERSION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("staging_snapshot_mismatch");
    }
  });
});

describe("evaluatePromotionGate — staging version must have testingApprovedAt", () => {
  it("blocks when staging version has no testingApprovedAt", () => {
    const result = evaluatePromotionGate(promotionProject(), {
      testingApprovedAt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("testing_approval_required");
      expect(result.extra?.versionId).toBe(7);
    }
  });

  it("blocks when stagingVersion row is null (not found in DB)", () => {
    const result = evaluatePromotionGate(promotionProject(), null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("testing_approval_required");
    }
  });

  it("blocks when untested staging snapshot tries to promote", () => {
    // User published to staging but never ran Testing against it.
    const result = evaluatePromotionGate(
      promotionProject({ testingStatus: "idle", testedSnapshotId: null }),
      { testingApprovedAt: null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // First check fires: testingStatus !== "passed"
      expect(result.code).toBe("testing_not_passed");
    }
  });
});

describe("evaluatePromotionGate — happy path", () => {
  it("allows promotion when all invariants are satisfied", () => {
    const result = evaluatePromotionGate(promotionProject(), APPROVED_VERSION);
    expect(result.ok).toBe(true);
  });

  it("approved matching staging snapshot promotes successfully", () => {
    const project = promotionProject({
      testingStatus: "passed",
      testedSnapshotId: 42,
      stagingPublishedSnapshotId: 42,
    });
    const stagingVer: GatePromotionVersion = {
      testingApprovedAt: new Date("2025-06-02T10:00:00Z"),
    };
    const result = evaluatePromotionGate(project, stagingVer);
    expect(result.ok).toBe(true);
  });
});
