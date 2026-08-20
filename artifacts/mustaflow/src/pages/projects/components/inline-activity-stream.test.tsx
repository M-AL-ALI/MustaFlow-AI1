import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendActivityEntry,
  InlineActivityStream,
  surfaceActivityEntry,
  taskActivityForEvent,
  type InlineActivityEntry,
} from "./inline-activity-stream";
import { InlineNarrationStream } from "./inline-narration-stream";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

describe("taskActivityForEvent", () => {
  it.each([
    ["thinking", "thinking", "Thinking"],
    ["reading_files", "reading", "Reading your project"],
    ["planning", "planning", "Planning"],
    ["generating_code", "writing", "Writing code"],
    ["check_deferred", "checking", "Choosing available checks"],
    ["review_context", "checking", "Preparing the review"],
    ["qa_step", "checking", "Testing what I built"],
    ["saving_version", "checkpoint", "Saving a checkpoint"],
    ["updating_preview", "preview", "Refreshing the preview"],
    ["completed", "done", "Done"],
    ["failed", "error", "Something needs attention"],
  ])("maps the real %s event to %s", (eventType, kind, label) => {
    expect(taskActivityForEvent(3, eventType)).toMatchObject({ id: 3, kind, label });
  });

  it("ignores events that do not represent an activity state", () => {
    expect(taskActivityForEvent(4, "narration")).toBeNull();
  });

  it("uses the existing Repairing event wording for the adapt state", () => {
    expect(taskActivityForEvent(5, "editing_files", "Repairing src/App.tsx")).toMatchObject({
      kind: "writing",
      label: "Adapting the fix",
      resolvedLabel: "Adapted the fix",
    });
  });

  it.each([
    [
      "tool_call",
      JSON.stringify({ tool: "read_file", args: { path: "src/App.tsx" } }),
      "reading",
      "Reading your project",
    ],
    [
      "loop:step",
      JSON.stringify({ stepIndex: 3, stepCap: 25, toolName: "apply_patch" }),
      "writing",
      "Writing code",
    ],
    [
      "tool_call",
      JSON.stringify({ tool: "dispatch_subagent", args: { role: "reviewer" } }),
      "checking",
      "Reviewing the change",
    ],
  ])(
    "derives an honest state from the production %s payload",
    (eventType, message, kind, label) => {
      expect(taskActivityForEvent(9, eventType, message)).toMatchObject({
        id: 9,
        kind,
        label,
      });
    },
  );

  it("does not call an unspecified subagent step a review", () => {
    expect(
      taskActivityForEvent(
        10,
        "loop:step",
        JSON.stringify({ stepIndex: 12, stepCap: 25, toolName: "dispatch_subagent" }),
      ),
    ).toMatchObject({
      kind: "thinking",
      label: "Working through the next step",
    });
  });
});

describe("InlineActivityStream", () => {
  it("pulses the real active state without inventing past-tense labels", () => {
    const entries = [
      taskActivityForEvent(1, "reading_files"),
      taskActivityForEvent(2, "planning"),
      taskActivityForEvent(3, "generating_code"),
    ].filter((entry): entry is InlineActivityEntry => entry !== null);

    render(<InlineActivityStream entries={entries} live />);

    const rows = screen.getAllByTestId("inline-activity-row");
    expect(rows[0]).toHaveAttribute("data-active", "false");
    expect(rows[0]).toHaveTextContent("Reading your project");
    expect(rows[1]).toHaveTextContent("Planning");
    expect(rows[2]).toHaveAttribute("data-active", "true");
    expect(rows[2]).toHaveTextContent("Writing code");
    expect(screen.getAllByTestId("resolved-activity-icon")).toHaveLength(2);
    expect(screen.getByTestId("active-activity-icon")).toHaveClass("motion-safe:animate-pulse");
    expect(screen.getByTestId("zero-avatar")).toHaveAttribute("aria-label", "Zero");
    expect(screen.getByTestId("zero-avatar")).toHaveAttribute("role", "img");
  });

  it("uses a persisted result event as completion evidence", () => {
    const editing = taskActivityForEvent(1, "editing_files");
    const checkpoint = taskActivityForEvent(2, "saving_version");
    const committed = taskActivityForEvent(3, "project_files_changed");
    if (!editing || !checkpoint || !committed) throw new Error("Expected file activity entries");
    let entries: InlineActivityEntry[] = [];
    entries = appendActivityEntry(entries, editing);
    entries = appendActivityEntry(entries, checkpoint);
    entries = appendActivityEntry(entries, committed);

    render(<InlineActivityStream entries={entries} live />);

    expect(screen.getByText("Wrote the code")).toBeVisible();
    expect(screen.getByText("Checkpoint saved")).toBeVisible();
    expect(screen.getByText("Saved the changes")).toBeVisible();
    expect(entries[0]?.completionEvidence).toEqual({
      source: "task-event",
      eventType: "project_files_changed",
    });
    expect(entries[1]?.completionEvidence).toEqual({
      source: "task-event",
      eventType: "project_files_changed",
    });
  });

  it("requires the final command observation before saying a check ran", () => {
    const running = taskActivityForEvent(
      1,
      "command_output",
      JSON.stringify({ status: "running", runId: "run-1" }),
    );
    const finished = taskActivityForEvent(
      2,
      "command_output",
      JSON.stringify({ status: "final", runId: "run-1", exitCode: 1 }),
    );
    if (!running || !finished) throw new Error("Expected command activity entries");

    const { rerender } = render(<InlineActivityStream entries={[running]} live />);
    expect(screen.getByText("Running a check")).toBeVisible();
    expect(screen.queryByText("Ran the check")).not.toBeInTheDocument();

    rerender(<InlineActivityStream entries={[finished]} live />);
    expect(screen.getByText("Ran the check")).toBeVisible();
  });

  it("never claims code was written when the atomic write rolls back", () => {
    const entries = [
      taskActivityForEvent(1, "editing_files"),
      taskActivityForEvent(2, "failed"),
    ].filter((entry): entry is InlineActivityEntry => entry !== null);

    render(<InlineActivityStream entries={entries} live />);

    expect(screen.getByText("Writing code")).toBeVisible();
    expect(screen.queryByText("Wrote the code")).not.toBeInTheDocument();
    expect(screen.getByText("Something needs attention")).toBeVisible();
  });

  it("never pairs a false checkpoint confirmation with the failure narration", () => {
    const entries = [
      taskActivityForEvent(1, "saving_version"),
      taskActivityForEvent(3, "completed"),
    ].filter((entry): entry is InlineActivityEntry => entry !== null);

    render(
      <>
        <InlineActivityStream entries={entries} live />
        <InlineNarrationStream
          entries={[
            {
              id: 2,
              text: "Couldn't save rollback checkpoint — your changes are still applied.",
            },
          ]}
        />
      </>,
    );

    expect(screen.getByText("Saving a checkpoint")).toBeVisible();
    expect(screen.queryByText("Checkpoint saved")).not.toBeInTheDocument();
    expect(
      screen.getByText("Couldn't save rollback checkpoint — your changes are still applied."),
    ).toBeVisible();
  });

  it("does not treat a later terminal as a dropped write confirmation", () => {
    const entries = [
      taskActivityForEvent(1, "editing_files"),
      taskActivityForEvent(3, "completed"),
    ].filter((entry): entry is InlineActivityEntry => entry !== null);

    render(<InlineActivityStream entries={entries} live />);

    expect(screen.getByText("Writing code")).toBeVisible();
    expect(screen.queryByText("Wrote the code")).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeVisible();
  });

  it("replaces repeated phases and renders terminal completion as a static check", () => {
    let entries: InlineActivityEntry[] = [];
    entries = appendActivityEntry(entries, taskActivityForEvent(1, "editing_files")!);
    entries = appendActivityEntry(entries, taskActivityForEvent(2, "generating_code")!);
    entries = appendActivityEntry(entries, taskActivityForEvent(3, "completed")!);

    render(<InlineActivityStream entries={entries} live />);

    expect(entries).toHaveLength(2);
    expect(screen.queryByTestId("active-activity-icon")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("resolved-activity-icon")).toHaveLength(2);
    expect(screen.getByText("Done")).toBeVisible();
  });

  it("uses real surface-operation state for brainstorm and publish activity", () => {
    expect(
      surfaceActivityEntry(10, "brainstorming", {
        status: "running",
        label: "Brainstorming",
      }),
    ).toMatchObject({ kind: "brainstorming", terminal: false });
    expect(
      surfaceActivityEntry(11, "publishing", {
        status: "completed",
        label: "Published",
      }),
    ).toMatchObject({ kind: "publishing", terminal: true });
    expect(
      surfaceActivityEntry(12, "publishing", {
        status: "failed",
        label: "Publishing needs attention",
      }),
    ).toMatchObject({ kind: "error", terminal: true });
  });
});
