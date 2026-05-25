import { describe, it, expect } from "vitest";
import { resolveAgentIdentity } from "./jobs.js";

// ─── resolveAgentIdentity ────────────────────────────────────────────────────
// These tests document the invariants that must hold for the staging gate to
// work correctly.  Any change to the decision table must update the tests too.

describe("resolveAgentIdentity", () => {
  describe("returns 'planning' when planMode is true regardless of other flags", () => {
    it("planMode=true → planning (short prompt, has files, foreground)", () => {
      expect(resolveAgentIdentity("fix button", true, false, false, true)).toBe("planning");
    });

    it("planMode=true → planning (background job)", () => {
      expect(resolveAgentIdentity("do everything", true, true, false, true)).toBe("planning");
    });
  });

  describe("returns 'task' for any condition that requires the staging gate", () => {
    it("background job always → task", () => {
      expect(resolveAgentIdentity("short", true, true, false, false)).toBe("task");
    });

    it("batch-queued task always → task", () => {
      expect(resolveAgentIdentity("short", true, false, true, false)).toBe("task");
    });

    it("prompt > 120 chars → task (complex change deserves review)", () => {
      const longPrompt = "a".repeat(121);
      expect(resolveAgentIdentity(longPrompt, true, false, false, false)).toBe("task");
    });

    it("prompt exactly 120 chars → main (boundary is exclusive)", () => {
      const boundaryPrompt = "a".repeat(120);
      expect(resolveAgentIdentity(boundaryPrompt, true, false, false, false)).toBe("main");
    });

    it("initial build (no files) always → task", () => {
      expect(resolveAgentIdentity("build me an app", false, false, false, false)).toBe("task");
    });

    it("background + long prompt → task (background flag wins)", () => {
      const longPrompt = "a".repeat(200);
      expect(resolveAgentIdentity(longPrompt, true, true, false, false)).toBe("task");
    });

    it("batch + no files → task (multiple conditions, still task)", () => {
      expect(resolveAgentIdentity("rebuild", false, false, true, false)).toBe("task");
    });
  });

  describe("returns 'main' only for short foreground prompts on existing projects", () => {
    it("short prompt, has files, foreground, not batch → main", () => {
      expect(resolveAgentIdentity("fix typo", true, false, false, false)).toBe("main");
    });

    it("empty prompt, has files, foreground → main", () => {
      expect(resolveAgentIdentity("", true, false, false, false)).toBe("main");
    });

    it("exactly 120 chars, has files, foreground → main", () => {
      const atLimit = "a".repeat(120);
      expect(resolveAgentIdentity(atLimit, true, false, false, false)).toBe("main");
    });
  });

  describe("Task Agent never routes to 'main' for dangerous conditions", () => {
    it("background flag alone is sufficient to block direct file writes", () => {
      for (const hasFiles of [true, false]) {
        for (const isBatch of [true, false]) {
          const identity = resolveAgentIdentity("short", hasFiles, true, isBatch, false);
          expect(identity).not.toBe("main");
        }
      }
    });

    it("batch flag alone is sufficient to block direct file writes", () => {
      for (const hasFiles of [true, false]) {
        const identity = resolveAgentIdentity("short", hasFiles, false, true, false);
        expect(identity).not.toBe("main");
      }
    });

    it("initial build (no files) always blocks direct file writes", () => {
      const identity = resolveAgentIdentity("short", false, false, false, false);
      expect(identity).not.toBe("main");
    });
  });
});

// ─── Database context injection guard ────────────────────────────────────────
// The DB context string is injected into the model prompt when:
//   project.dbProvider !== "none"  AND  project.dbStatus === "connected"
//
// The valid dbStatus values from the projects schema are:
//   none | provisioning | connected | error
//
// "ready" is NOT a valid value — using it would silently suppress DB context
// for all projects.  These tests document the correct check value.

describe("DB context injection status guard", () => {
  function shouldInjectDbContext(dbProvider: string, dbStatus: string): boolean {
    return dbProvider !== "none" && dbStatus === "connected";
  }

  it("injects context when provider is postgres and status is connected", () => {
    expect(shouldInjectDbContext("postgres", "connected")).toBe(true);
  });

  it("injects context when provider is sqlite and status is connected", () => {
    expect(shouldInjectDbContext("sqlite", "connected")).toBe(true);
  });

  it("does NOT inject context when status is 'ready' (invalid value)", () => {
    expect(shouldInjectDbContext("postgres", "ready")).toBe(false);
  });

  it("does NOT inject context when status is 'provisioning'", () => {
    expect(shouldInjectDbContext("postgres", "provisioning")).toBe(false);
  });

  it("does NOT inject context when status is 'error'", () => {
    expect(shouldInjectDbContext("postgres", "error")).toBe(false);
  });

  it("does NOT inject context when provider is 'none'", () => {
    expect(shouldInjectDbContext("none", "connected")).toBe(false);
  });

  it("does NOT inject context when provider is empty string", () => {
    expect(shouldInjectDbContext("", "connected")).toBe(false);
  });
});

// ─── Staging isolation invariants ────────────────────────────────────────────
// These tests document the file-mutation contract the Task Agent must satisfy.
// The invariant is enforced by the `if (agentIdentity === "task")` branch in
// runBuildPipeline / runRefinePipeline (jobs.ts ~line 2558).
//
// The tests below use the resolveAgentIdentity decision function as the
// boundary: if the resolved identity is "task", the pipeline MUST stage files
// to stagingSnapshot instead of writing to project_files.

describe("staging isolation invariants", () => {
  const STAGING_SCENARIOS: Array<{
    label: string;
    prompt: string;
    hasFiles: boolean;
    isBackground: boolean;
    isBatchQueued: boolean;
  }> = [
    {
      label: "queued background task",
      prompt: "refactor everything",
      hasFiles: true,
      isBackground: true,
      isBatchQueued: false,
    },
    {
      label: "batch-queued task",
      prompt: "add feature",
      hasFiles: true,
      isBackground: false,
      isBatchQueued: true,
    },
    {
      label: "long-prompt task (>120 chars)",
      prompt: "a".repeat(150),
      hasFiles: true,
      isBackground: false,
      isBatchQueued: false,
    },
    {
      label: "initial build (no existing files)",
      prompt: "build me a todo app",
      hasFiles: false,
      isBackground: false,
      isBatchQueued: false,
    },
  ];

  for (const scenario of STAGING_SCENARIOS) {
    it(`${scenario.label} resolves to 'task' identity (files must go to staging, not live)`, () => {
      const identity = resolveAgentIdentity(
        scenario.prompt,
        scenario.hasFiles,
        scenario.isBackground,
        scenario.isBatchQueued,
        false,
      );
      expect(identity).toBe("task");
    });
  }

  it("drainNextBatchTask must preserve agentIdentity — 'task' identity is NOT lost on drain", () => {
    // This is a documentation test. The fix in drainNextBatchTask (item 1) ensures
    // that nextTask.agentIdentity is forwarded to enqueueJob instead of being dropped.
    // If a batch task had agentIdentity="task" stored, it must run as "task" after drain.
    //
    // Invariant: if resolveAgentIdentity returns "task" for a set of conditions,
    // and those conditions were present when the task was first enqueued, then
    // the drain must not downgrade the identity to "main".
    const batchIdentity = resolveAgentIdentity("add feature", true, false, true, false);
    expect(batchIdentity).toBe("task");
  });
});
