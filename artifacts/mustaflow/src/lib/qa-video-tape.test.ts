import { describe, expect, it } from "vitest";
import {
  collapseQATapeEvents,
  extractQATapeSteps,
  parseQACardEvent,
  type QATapeEvent,
} from "./qa-video-tape";

describe("QA video tape", () => {
  it("preserves readable live steps and take_screenshot attachments on the existing stream", () => {
    const events: QATapeEvent[] = [
      {
        id: 1,
        eventType: "qa_step",
        message: "Opened the app",
        data: {
          kind: "qa_tape_step",
          phase: "navigation",
          status: "passed",
          screenshot: {
            tool: "take_screenshot",
            mimeType: "image/jpeg",
            base64: "aW1hZ2U=",
            bytes: 5,
            label: "App opened",
          },
        },
      },
      {
        id: 2,
        eventType: "qa_step",
        message: "Clicked 'Add task'",
        data: {
          kind: "qa_tape_step",
          phase: "interaction",
          status: "passed",
        },
      },
      {
        id: 3,
        eventType: "qa_done",
        message: "All tests passed (2 steps)",
      },
    ];

    const collapsed = collapseQATapeEvents(events);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.eventType).toBe("qa_card");

    const card = parseQACardEvent(collapsed[0]!);
    expect(card).toMatchObject({
      terminal: "qa_done",
      terminalMessage: "All tests passed (2 steps)",
      steps: [
        {
          message: "Opened the app",
          phase: "navigation",
          status: "passed",
          screenshot: {
            tool: "take_screenshot",
            mimeType: "image/jpeg",
            bytes: 5,
          },
        },
        {
          message: "Clicked 'Add task'",
          phase: "interaction",
          status: "passed",
        },
      ],
    });
  });

  it("keeps legacy plain qa_step messages visible", () => {
    const [event] = collapseQATapeEvents<QATapeEvent>([
      { id: 1, eventType: "qa_step", message: "Launching QA browser..." },
    ]);
    const card = parseQACardEvent(event!);
    expect(card?.steps).toEqual([
      {
        message: "Launching QA browser...",
        phase: "unknown",
        status: "passed",
      },
    ]);
  });

  it("extracts persisted and live QA steps in event order", () => {
    const steps = extractQATapeSteps<QATapeEvent>([
      {
        id: 11,
        eventType: "qa_step",
        message: "Opened the app",
        data: { kind: "qa_tape_step", phase: "launch", status: "passed" },
      },
      {
        id: 12,
        eventType: "file_diff",
        message: "Changed src/App.tsx",
      },
      {
        id: 13,
        eventType: "qa_step",
        message: "Clicked 'Add task'",
        data: { kind: "qa_tape_step", phase: "interaction", status: "passed" },
      },
    ]);

    expect(steps.map((step) => step.message)).toEqual(["Opened the app", "Clicked 'Add task'"]);
  });
});
