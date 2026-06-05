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

  describe("returns 'main' for build execution signals", () => {
    it("background job always → main", () => {
      expect(resolveAgentIdentity("short", true, true, false, false)).toBe("main");
    });

    it("batch-queued task always → main", () => {
      expect(resolveAgentIdentity("short", true, false, true, false)).toBe("main");
    });

    it("prompt > 120 chars → main", () => {
      const longPrompt = "a".repeat(121);
      expect(resolveAgentIdentity(longPrompt, true, false, false, false)).toBe("main");
    });

    it("prompt exactly 120 chars → main (boundary is exclusive)", () => {
      const boundaryPrompt = "a".repeat(120);
      expect(resolveAgentIdentity(boundaryPrompt, true, false, false, false)).toBe("main");
    });

    it("initial build (no files) always → main", () => {
      expect(resolveAgentIdentity("build me an app", false, false, false, false)).toBe("main");
    });

    it("background + long prompt → main", () => {
      const longPrompt = "a".repeat(200);
      expect(resolveAgentIdentity(longPrompt, true, true, false, false)).toBe("main");
    });

    it("batch + no files → main", () => {
      expect(resolveAgentIdentity("rebuild", false, false, true, false)).toBe("main");
    });
  });

  describe("returns 'main' for normal direct execution", () => {
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

  describe("Task Agent is no longer selected by routing", () => {
    it("background flag alone still routes to Main Agent", () => {
      for (const hasFiles of [true, false]) {
        for (const isBatch of [true, false]) {
          const identity = resolveAgentIdentity("short", hasFiles, true, isBatch, false);
          expect(identity).toBe("main");
        }
      }
    });

    it("batch flag alone still routes to Main Agent", () => {
      for (const hasFiles of [true, false]) {
        const identity = resolveAgentIdentity("short", hasFiles, false, true, false);
        expect(identity).toBe("main");
      }
    });

    it("initial build routes to Main Agent", () => {
      const identity = resolveAgentIdentity("short", false, false, false, false);
      expect(identity).toBe("main");
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
    return !!dbProvider && dbProvider !== "none" && dbStatus === "connected";
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
// New routing no longer selects Task Agent. Background, batch, long prompts,
// and initial builds all execute through Main Agent so preview reads committed
// project_files. Legacy rows with agentIdentity="task" are still handled by
// the old staging branch for apply/discard compatibility.

describe("Agent Zero v2 routing invariants", () => {
  const MAIN_AGENT_SCENARIOS: Array<{
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

  for (const scenario of MAIN_AGENT_SCENARIOS) {
    it(`${scenario.label} resolves to Main Agent`, () => {
      const identity = resolveAgentIdentity(
        scenario.prompt,
        scenario.hasFiles,
        scenario.isBackground,
        scenario.isBatchQueued,
        false,
      );
      expect(identity).toBe("main");
    });
  }

  it("batch routing no longer creates new Task Agent rows", () => {
    const batchIdentity = resolveAgentIdentity("add feature", true, false, true, false);
    expect(batchIdentity).toBe("main");
  });
});
