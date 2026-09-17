import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskQueuedMessage, queuedTaskLabel, type QueuedTaskState } from "./task-queued-message";

afterEach(cleanup);

const task: QueuedTaskState = {
  id: 351,
  projectId: 61,
  status: "building",
  runMode: "foreground",
};

describe("queued task message uses persisted task truth", () => {
  it.each([
    ["queued", "foreground", "Task queued"],
    ["queued", "background", "Task queued in background"],
    ["building", "foreground", "Task running"],
    ["building", "background", "Background task running"],
    ["completed", "foreground", "View task results"],
    ["completed", "background", "View task results"],
    ["failed", "foreground", "Task failed"],
    ["needs_review", "foreground", "Task ready for review"],
    ["needs_fix", "foreground", "Task needs attention"],
    ["cancelled", "background", "Task stopped"],
    ["paused", "foreground", "Task paused"],
    ["future-status", "background", "View task details"],
  ])(
    "renders %s / %s without claiming background or successful validation",
    (status, runMode, expected) => {
      expect(queuedTaskLabel({ ...task, status, runMode })).toBe(expected);
    },
  );

  it("opens the matching foreground task rather than a background-only drawer", () => {
    const open = vi.fn();
    render(<TaskQueuedMessage projectId={61} taskId={351} tasks={[task]} onOpenTask={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Task running" }));
    expect(open).toHaveBeenCalledWith(351);
    expect(screen.queryByText("Task queued in background")).not.toBeInTheDocument();
  });

  it("updates a historic queue message when the persisted task finishes", () => {
    const open = vi.fn();
    const view = render(
      <TaskQueuedMessage projectId={61} taskId={351} tasks={[task]} onOpenTask={open} />,
    );
    view.rerender(
      <TaskQueuedMessage
        projectId={61}
        taskId={351}
        tasks={[{ ...task, status: "completed" }]}
        onOpenTask={open}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View task results" }));
    expect(open).toHaveBeenCalledWith(351);
    expect(screen.queryByText(/all checks passed/i)).not.toBeInTheDocument();
  });

  it.each([undefined, null, "351", -1, 0, NaN, Infinity, 1.5])(
    "does not navigate on malformed or missing task ID %s",
    (taskId) => {
      const open = vi.fn();
      render(<TaskQueuedMessage projectId={61} taskId={taskId} tasks={[task]} onOpenTask={open} />);
      const button = screen.getByRole("button", { name: "Task status unavailable" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("does not expose or open another project's cached task", () => {
    const open = vi.fn();
    render(<TaskQueuedMessage projectId={62} taskId={351} tasks={[task]} onOpenTask={open} />);
    expect(screen.getByRole("button", { name: "Task status unavailable" })).toBeDisabled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not invent a run mode while tasks are loading", () => {
    render(<TaskQueuedMessage projectId={61} taskId={351} tasks={[]} onOpenTask={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Task status unavailable" })).toBeDisabled();
    expect(queuedTaskLabel({ ...task, runMode: undefined })).toBe("Task running");
  });

  it("wires the main editor to its real task feed and task-results action", () => {
    const source = readFileSync(resolve("src/pages/projects/[id].tsx"), "utf8");
    expect(source).toContain("<TaskQueuedMessage");
    expect(source).toContain("tasks={tasksForFeed}");
    expect(source).toContain("onOpenTask={openRecoveryTaskRun}");
    expect(source).not.toContain("<span>Task queued in background</span>");
  });
});
