import { describe, it, expect } from "vitest";
import { evaluatePublishGate } from "../publish-gate";
import type { GateProject, GateSnapshotFile, GateSpecVersion } from "../publish-gate";

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
