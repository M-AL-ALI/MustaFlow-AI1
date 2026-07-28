import { beforeEach, describe, expect, it, vi } from "vitest";

const qaMocks = vi.hoisted(() => {
  const button = {
    getAttribute: vi.fn(async (name: string) => (name === "aria-label" ? "Add task" : null)),
    textContent: vi.fn(async () => "Add task"),
    isDisabled: vi.fn(async () => false),
    click: vi.fn(async () => undefined),
  };
  const input = {
    getAttribute: vi.fn(async (name: string) => (name === "placeholder" ? "Task title" : null)),
    textContent: vi.fn(async () => ""),
    fill: vi.fn(async () => undefined),
  };
  const empty = {
    count: vi.fn(async () => 0),
    nth: vi.fn(),
  };
  const root = {
    first: vi.fn(),
    innerText: vi.fn(async () => "A working app"),
    locator: vi.fn(() => ({ count: vi.fn(async () => 2) })),
    boundingBox: vi.fn(async () => ({ width: 100, height: 100 })),
  };
  root.first.mockReturnValue(root);
  const page = {
    on: vi.fn(),
    goto: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from("frame")),
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn((selector: string) => {
      if (selector === "#root, body") return root;
      if (selector.startsWith("button")) {
        return { count: vi.fn(async () => 1), nth: vi.fn(() => button) };
      }
      if (selector.startsWith("a[")) return empty;
      return { count: vi.fn(async () => 1), nth: vi.fn(() => input) };
    }),
  };
  const browser = {
    newContext: vi.fn(async () => ({ newPage: vi.fn(async () => page) })),
    close: vi.fn(async () => undefined),
  };
  return {
    button,
    input,
    page,
    root,
    browser,
    launch: vi.fn(async () => browser),
  };
});

vi.mock("playwright", () => ({
  chromium: {
    launch: qaMocks.launch,
  },
}));

import { runHeadlessQA, type QAStepEventData } from "./headless-qa";

describe("headless QA tape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams readable actions and bounded take_screenshot frames", async () => {
    const events: Array<{ type: string; message: string; data?: QAStepEventData }> = [];

    const result = await runHeadlessQA(
      [
        {
          path: "index.html",
          content: "<main><button>Add task</button><input placeholder='Task title'></main>",
          mimeType: "text/html",
        },
      ],
      async (type, message, data) => {
        events.push({ type, message, data });
      },
    );

    expect(result).toEqual({ passed: true, errors: [], stepsRun: 4 });
    expect(events.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        "Opened the app",
        "Clicked 'Add task'",
        "Typed 'buy milk' into 'Task title'",
        "No browser errors found",
      ]),
    );
    const screenshots = events.flatMap((event) =>
      event.data?.screenshot ? [event.data.screenshot] : [],
    );
    expect(screenshots).toHaveLength(3);
    expect(screenshots.every((shot) => shot.tool === "take_screenshot")).toBe(true);
    expect(screenshots.every((shot) => shot.bytes <= 160 * 1024)).toBe(true);
    expect(qaMocks.button.click).toHaveBeenCalledOnce();
    expect(qaMocks.input.fill).toHaveBeenCalledWith("buy milk", { timeout: 2_000 });
  });

  it("uses the booted preview URL and reports a blank page as runtime evidence", async () => {
    qaMocks.root.innerText.mockResolvedValueOnce("");
    qaMocks.root.locator
      .mockReturnValueOnce({ count: vi.fn(async () => 0) })
      .mockReturnValueOnce({ count: vi.fn(async () => 0) });
    qaMocks.root.boundingBox.mockResolvedValueOnce({ width: 0, height: 0 });
    const events: Array<{ type: string; message: string }> = [];

    const result = await runHeadlessQA(
      [],
      async (type, message) => {
        events.push({ type, message });
      },
      undefined,
      { targetUrl: "https://preview.example.test" },
    );

    expect(qaMocks.page.goto).toHaveBeenCalledWith("https://preview.example.test", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toContain("Preview rendered a blank page");
    expect(events).toContainEqual({
      type: "qa_step",
      message: "Error: Preview rendered a blank page",
    });
  });
});
