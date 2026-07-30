import { describe, expect, it, vi } from "vitest";
import { ListTasksResponse } from "@workspace/api-zod";
import type { TaskReport } from "@workspace/db";
import {
  PERSIST_ARCHITECT_AUTO_FIX_LINK_SQL,
  persistArchitectAutoFixLink,
} from "./architect-auto-fix-link";

type ArchitectReview = NonNullable<TaskReport["architectReview"]>;

const baseReview: ArchitectReview = {
  verdict: "partial",
  summary: "TypeScript check failed.",
  findings: [
    {
      severity: "critical",
      title: "TypeScript check failed",
      detail: "The typecheck exited non-zero.",
      file: "src/App.tsx",
    },
  ],
  nextActions: ["Fix the type error and rerun the check."],
  autoFixQueued: true,
  autoFixTaskId: 148,
  creditsCharged: 0,
  reviewedAt: "2026-07-29T21:09:18.855Z",
  model: "gpt-5-mini",
  isReReview: false,
  completedWithWarnings: false,
};

describe("persistArchitectAutoFixLink", () => {
  it("adds the link after an earlier report write without disturbing other fields", async () => {
    const stored: { report: TaskReport } = {
      report: {
        userRequest: "Run the repair check.",
        filesCreated: ["src/App.tsx"],
        filesChanged: [],
        filesRemoved: [],
        previewUpdated: true,
        warnings: ["Agent loop terminated: step-cap"],
        integrationsNeeded: [],
        versionId: 85,
      },
    };
    const query = vi.fn(async (text: string, values: unknown[]) => {
      expect(text).toBe(PERSIST_ARCHITECT_AUTO_FIX_LINK_SQL);
      expect(values[0]).toBe(147);
      stored.report = {
        ...stored.report,
        architectReview: JSON.parse(String(values[1])) as ArchitectReview,
      };
    });

    await expect(
      persistArchitectAutoFixLink({
        taskId: 147,
        architectReview: baseReview,
        query,
      }),
    ).resolves.toBe(true);

    expect(stored.report).toMatchObject({
      userRequest: "Run the repair check.",
      filesCreated: ["src/App.tsx"],
      warnings: ["Agent loop terminated: step-cap"],
      versionId: 85,
      architectReview: {
        autoFixQueued: true,
        autoFixTaskId: 148,
      },
    });
  });

  it("does not write a link when no auto-fix was queued", async () => {
    const query = vi.fn(async () => undefined);

    await expect(
      persistArchitectAutoFixLink({
        taskId: 147,
        architectReview: {
          ...baseReview,
          autoFixQueued: false,
          autoFixTaskId: null,
        },
        query,
      }),
    ).resolves.toBe(false);

    expect(query).not.toHaveBeenCalled();
  });
});

describe("ListTasksResponse architect auto-fix link", () => {
  const task = {
    id: 147,
    projectId: 44,
    title: "Run repair check",
    kind: "main",
    status: "completed",
    completionKind: "step_cap",
    report: {
      userRequest: "Run the repair check.",
      filesCreated: ["src/App.tsx"],
      warnings: ["Agent loop terminated: step-cap"],
      versionId: 85,
    },
    createdAt: "2026-07-29T21:03:39.147Z",
  } as const;

  it("preserves the machine-readable link in the serialized list-task payload", () => {
    const parsed = ListTasksResponse.parse([
      {
        ...task,
        report: {
          ...task.report,
          architectReview: baseReview,
        },
      },
    ]);

    expect(parsed[0]?.report).toMatchObject({
      userRequest: "Run the repair check.",
      warnings: ["Agent loop terminated: step-cap"],
      architectReview: {
        autoFixQueued: true,
        autoFixTaskId: 148,
      },
    });
  });

  it("leaves architectReview absent when no review was present", () => {
    const parsed = ListTasksResponse.parse([task]);
    expect(parsed[0]?.report).not.toHaveProperty("architectReview");
  });
});
