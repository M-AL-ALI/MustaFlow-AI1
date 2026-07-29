import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildRunReplayModel, InlineRunGroup } from "./inline-run-group";

describe("buildRunReplayModel", () => {
  it("reconstructs ordered activity, narration, and QA from existing events", () => {
    const replay = buildRunReplayModel([
      { id: 4, eventType: "completed", message: "Done" },
      { id: 2, eventType: "narration", message: "I found the subtitle." },
      { id: 1, eventType: "reading_files", message: "Reading files" },
      {
        id: 3,
        eventType: "qa_step",
        message: "Opened the app",
        data: { kind: "qa_tape_step", phase: "launch", status: "passed" },
      },
      { id: 5, eventType: "heartbeat", message: "Still alive" },
    ]);

    expect(replay.stepCount).toBe(4);
    expect(replay.activities.map((entry) => entry.kind)).toEqual([
      "reading",
      "checking",
      "done",
    ]);
    expect(replay.narrations).toEqual([{ id: 2, text: "I found the subtitle." }]);
    expect(replay.qaEvents).toHaveLength(1);
  });
});

describe("InlineRunGroup", () => {
  it("shows live steps and auto-collapses when the run completes", () => {
    const { rerender } = render(
      <InlineRunGroup stepCount={3} live>
        <div>Live run detail</div>
      </InlineRunGroup>,
    );

    expect(screen.getByTestId("inline-run-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Live run detail")).toBeVisible();

    rerender(
      <InlineRunGroup stepCount={12} live={false}>
        <div>Live run detail</div>
      </InlineRunGroup>,
    );

    expect(screen.getByTestId("inline-run-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("12 steps · expand to replay")).toBeVisible();
    expect(screen.queryByText("Live run detail")).not.toBeInTheDocument();
  });

  it("starts persisted runs collapsed and expands on demand", () => {
    render(
      <InlineRunGroup stepCount={5} live={false}>
        <div>Persisted detail</div>
      </InlineRunGroup>,
    );

    fireEvent.click(screen.getByTestId("inline-run-toggle"));
    expect(screen.getByText("Persisted detail")).toBeVisible();
    expect(screen.getByText("5 steps · collapse replay")).toBeVisible();
  });
});
