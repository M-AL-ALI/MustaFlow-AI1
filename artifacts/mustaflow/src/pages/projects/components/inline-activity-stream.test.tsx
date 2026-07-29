import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendActivityEntry,
  InlineActivityStream,
  taskActivityForEvent,
  type InlineActivityEntry,
} from "./inline-activity-stream";

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
});

describe("InlineActivityStream", () => {
  it("pulses the real active state and turns resolved states into checks", () => {
    const entries = [
      taskActivityForEvent(1, "reading_files"),
      taskActivityForEvent(2, "planning"),
      taskActivityForEvent(3, "generating_code"),
    ].filter((entry): entry is InlineActivityEntry => entry !== null);

    render(<InlineActivityStream entries={entries} live />);

    const rows = screen.getAllByTestId("inline-activity-row");
    expect(rows[0]).toHaveAttribute("data-active", "false");
    expect(rows[0]).toHaveTextContent("Read your project");
    expect(rows[1]).toHaveTextContent("Planned the change");
    expect(rows[2]).toHaveAttribute("data-active", "true");
    expect(rows[2]).toHaveTextContent("Writing code");
    expect(screen.getAllByTestId("resolved-activity-icon")).toHaveLength(2);
    expect(screen.getByTestId("active-activity-icon")).toHaveClass("animate-pulse");
    expect(screen.getByTestId("zero-avatar")).toHaveAttribute("aria-label", "Zero");
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
});
