import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  appendRecoveryStep,
  InlineRecoveryLoop,
  recoveryStepForEvent,
  type InlineRecoveryStep,
} from "./inline-recovery-loop";

describe("recoveryStepForEvent", () => {
  it("maps the existing repair events to try, adapt, and observe", () => {
    expect(
      recoveryStepForEvent({
        id: 1,
        eventType: "qa_step",
        message: "Runtime issue detected - Zero is making one repair pass",
        data: { kind: "qa_tape_step", phase: "repair", status: "running" },
      }),
    ).toMatchObject({ phase: "try", status: "running" });
    expect(
      recoveryStepForEvent({
        id: 2,
        eventType: "editing_files",
        message: "Repairing src/App.tsx",
      }),
    ).toMatchObject({ phase: "adapt", message: "Adjusted src/App.tsx" });
    expect(
      recoveryStepForEvent({
        id: 3,
        eventType: "qa_step",
        message: "Runtime repair verified",
        data: { kind: "qa_tape_step", phase: "repair", status: "passed" },
      }),
    ).toMatchObject({ phase: "observe", status: "passed" });
  });
});

describe("InlineRecoveryLoop", () => {
  it("shows a calm inline retry beside a failed observation", () => {
    const retry = vi.fn();
    const steps: InlineRecoveryStep[] = [
      { id: 1, phase: "try", message: "Made one repair pass", status: "passed" },
      { id: 2, phase: "adapt", message: "Adjusted src/App.tsx", status: "passed" },
      {
        id: 3,
        phase: "observe",
        message: "The runtime issue remains",
        status: "failed",
      },
    ];

    render(<InlineRecoveryLoop steps={steps} onRetry={retry} />);

    expect(
      screen.getAllByTestId("inline-recovery-step").map((step) => step.getAttribute("data-phase")),
    ).toEqual(["try", "adapt", "observe"]);
    fireEvent.click(screen.getByText("Try another fix"));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("deduplicates ordered recovery events", () => {
    let steps: InlineRecoveryStep[] = [];
    steps = appendRecoveryStep(steps, {
      id: 2,
      phase: "adapt",
      message: "Adjusted file",
      status: "running",
    });
    steps = appendRecoveryStep(steps, {
      id: 1,
      phase: "try",
      message: "Trying",
      status: "running",
    });
    steps = appendRecoveryStep(steps, {
      id: 2,
      phase: "adapt",
      message: "Duplicate",
      status: "running",
    });
    expect(steps.map((step) => step.id)).toEqual([1, 2]);
  });
});
