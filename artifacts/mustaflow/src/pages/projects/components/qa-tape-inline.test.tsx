import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QATapeEvent } from "@/lib/qa-video-tape";
import { QATapeInline } from "./qa-tape-inline";

const persisted = vi.hoisted(() => ({ events: [] as QATapeEvent[] }));

vi.mock("@workspace/api-client-react", () => ({
  getListTaskEventsQueryKey: (projectId: number, taskId: number) => [
    `/api/projects/${projectId}/tasks/${taskId}/events`,
  ],
  useListTaskEvents: () => ({ data: persisted.events }),
}));

function step(id: number, message: string, screenshot = false): QATapeEvent {
  return {
    id,
    eventType: "qa_step",
    message,
    data: {
      kind: "qa_tape_step",
      phase: id === 1 ? "launch" : "interaction",
      status: "passed",
      ...(screenshot
        ? {
            screenshot: {
              tool: "take_screenshot",
              mimeType: "image/jpeg",
              base64: "aW1hZ2U=",
              bytes: 5,
              label: "QA app view",
            },
          }
        : {}),
    },
  };
}

describe("QATapeInline", () => {
  it("shows live steps immediately in order and keeps the screenshot bounded", () => {
    persisted.events = [step(1, "Opened the app")];

    render(
      <QATapeInline
        projectId={45}
        taskId={901}
        live
        liveEvents={[step(3, "Typed 'buy milk'", true), step(2, "Clicked 'Add task'")]}
      />,
    );

    expect(screen.getAllByTestId("qa-tape-step").map((line) => line.textContent)).toEqual([
      "Opened the app",
      "Clicked 'Add task'",
      "Typed 'buy milk'",
    ]);
    const screenshot = screen.getByTestId("qa-tape-screenshot");
    expect(screenshot).toHaveAttribute("src", "data:image/jpeg;base64,aW1hZ2U=");
    expect(screenshot).toHaveAttribute("alt", "QA app view");
    expect(screenshot).toHaveClass("max-h-40", "max-w-full");
  });

  it("reconstructs the same tape from persisted events after reload", () => {
    persisted.events = [
      step(21, "Opened the app"),
      step(22, "Clicked 'Add task'"),
      step(23, "Typed 'buy milk'", true),
    ];

    render(<QATapeInline projectId={45} taskId={902} />);

    expect(screen.getAllByTestId("qa-tape-step").map((line) => line.textContent)).toEqual([
      "Opened the app",
      "Clicked 'Add task'",
      "Typed 'buy milk'",
    ]);
    expect(screen.getByTestId("qa-tape-screenshot")).toBeVisible();
  });
});
