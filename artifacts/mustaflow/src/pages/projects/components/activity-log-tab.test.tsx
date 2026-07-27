import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ActivityLogTab } from "./activity-log-tab";

describe("Builder activity log", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads and renders a completed task's persisted event", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: -901,
            actorName: "Agent Zero",
            eventType: "build",
            summary:
              "Built 15 files — reached the step limit; you can continue with a follow-up prompt.",
            metadata: {
              source: "task_event",
              taskId: 110,
              taskEventType: "completed",
            },
            createdAt: new Date().toISOString(),
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    render(<ActivityLogTab projectId={42} />);

    expect(
      await screen.findByText(
        "Built 15 files — reached the step limit; you can continue with a follow-up prompt.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("by Agent Zero")).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/42/activity-log?limit=100");
  });
});
