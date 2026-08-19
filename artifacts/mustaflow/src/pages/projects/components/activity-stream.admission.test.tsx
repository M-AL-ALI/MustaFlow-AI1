import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => ({
  events: [
    {
      id: 81,
      taskId: 44,
      eventType: "failed",
      message: "Your plan allows 1 running build at once. Wait for one to finish, then try again.",
      filePath: null,
      createdAt: "2026-08-19T12:00:00.000Z",
      data: {
        code: "parallel_build_limit_reached",
        completionKind: "admission_blocked",
      },
    },
  ],
}));

vi.mock("@/hooks/use-task-event-stream", () => ({
  useTaskEventStream: () => ({ events: stream.events, lastEventAt: 1, isConnected: false }),
}));

import { ActivityStream } from "./activity-stream";

describe("ActivityStream admission terminal", () => {
  it("shows a calm failed state for a capacity rejection and never a success glyph", () => {
    render(
      <ActivityStream
        projectId={12}
        taskId={44}
        taskStatus="failed"
        completionKind="admission_blocked"
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "This build did not start because the account is already at its running-build limit",
      ),
    ).toHaveClass("text-destructive");
    expect(screen.getByTitle("Failed")).toHaveClass("text-destructive");
    expect(screen.queryByTitle("Completed")).not.toBeInTheDocument();
    expect(screen.queryByText("Build complete")).not.toBeInTheDocument();
    expect(screen.queryByText("Build failed")).not.toBeInTheDocument();
  });
});
