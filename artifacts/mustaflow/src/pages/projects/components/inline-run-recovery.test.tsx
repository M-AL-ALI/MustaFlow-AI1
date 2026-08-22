import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  task147AfterReportLink,
  task147Events,
  task148Captured,
  task148Events,
} from "./__fixtures__/wave-d36-task-147-148";
import {
  commandFailuresForEvents,
  InlineRunRecoveryStory,
  refreshSourceReportsForTaskQueuedSignals,
  resolveLinkedRecoveryTask,
} from "./inline-run-recovery";
import { recoveryStepForEvent } from "./inline-recovery-loop";

describe("Wave D.3.6 captured task 147/148 recovery", () => {
  it("extracts real command failures even though production encoded details in message", () => {
    const failures = commandFailuresForEvents([...task147Events]);

    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.label)).toEqual([
      "TypeScript check",
      "TypeScript check",
    ]);
    expect(failures.map((failure) => failure.exitCode)).toEqual([1, 1]);
    expect(failures[0]?.detail).toContain("blocked a child process");
    expect(failures[1]?.detail).toContain("not available inside the isolated workspace");
  });

  it("confirms the step-cap run had no in-run repair events", () => {
    const repairSteps = task147Events.map((event) => recoveryStepForEvent(event)).filter(Boolean);

    expect(repairSteps).toEqual([]);
    expect(task147Events.at(-1)).toMatchObject({
      eventType: "completed",
      message: "Completed at the step limit — you can continue with a follow-up prompt.",
    });
  });

  it("associates task 148 only through the persisted report link", () => {
    const tasks = [task147AfterReportLink, task148Captured];
    expect(resolveLinkedRecoveryTask(task147AfterReportLink.report, tasks)).toMatchObject({
      id: 148,
      status: "building",
    });

    // The production title and event timing are deliberately not association inputs.
    expect(resolveLinkedRecoveryTask(null, [task148Captured])).toBeNull();
    expect(task148Events.slice(0, 3).map((event) => event.eventType)).toEqual([
      "queued",
      "narration",
      "reading_files",
    ]);
  });

  it("refetches source reports exactly once when the real task-queued signal arrives", () => {
    const seen = new Set<number>();
    const refetch = vi.fn();
    const signal = { kind: "task-queued", taskId: 148 };

    expect(refreshSourceReportsForTaskQueuedSignals([signal], seen, refetch)).toBe(true);
    expect(refetch).toHaveBeenCalledOnce();
    expect(refreshSourceReportsForTaskQueuedSignals([signal], seen, refetch)).toBe(false);
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders the calm linked recovery story and jumps to the real fix run", () => {
    const openTask = vi.fn();
    const failures = commandFailuresForEvents([...task147Events]);

    render(
      <InlineRunRecoveryStory
        failures={failures}
        completionKind="step_cap"
        linkedTask={task148Captured}
        onOpenTask={openTask}
      />,
    );

    expect(screen.getByText("A check needs attention.")).toBeVisible();
    expect(screen.getByText(/used all its available steps/i)).toBeVisible();
    expect(
      screen.getByText("Zero is fixing the TypeScript check in the background."),
    ).toBeVisible();
    expect(screen.getAllByTestId("inline-recovery-step").map((row) => row.dataset.phase)).toEqual([
      "try",
      "observe",
      "adapt",
    ]);
    expect(screen.getByTestId("inline-run-recovery-story").className).not.toMatch(
      /bg-red|border-red/,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open fix run" }));
    expect(openTask).toHaveBeenCalledWith(148);
  });

  it("reflects the linked task outcome back on the source run", () => {
    const failures = commandFailuresForEvents([...task147Events]);
    render(
      <InlineRunRecoveryStory
        failures={failures}
        completionKind="step_cap"
        linkedTask={{ ...task148Captured, status: "completed" }}
      />,
    );

    expect(screen.getByText("Outcome unavailable for this older run")).toBeVisible();
    expect(screen.queryByText("The TypeScript check fix completed.")).not.toBeInTheDocument();
  });
});
