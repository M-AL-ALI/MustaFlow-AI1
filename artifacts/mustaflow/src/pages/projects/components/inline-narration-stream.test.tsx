import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendNarrationEntry,
  InlineNarrationStream,
  narrationForTaskEvent,
  type InlineNarrationEntry,
} from "./inline-narration-stream";

afterEach(() => {
  vi.useRealTimers();
});

describe("appendNarrationEntry", () => {
  it("deduplicates, orders, and trims live narration", () => {
    let entries: InlineNarrationEntry[] = [];
    for (let id = 14; id >= 1; id -= 1) {
      entries = appendNarrationEntry(entries, { id, text: `Step ${id}` });
    }
    entries = appendNarrationEntry(entries, { id: 14, text: "Duplicate" });

    expect(entries).toHaveLength(12);
    expect(entries[0]).toEqual({ id: 3, text: "Step 3" });
    expect(entries.at(-1)).toEqual({ id: 14, text: "Step 14" });
  });

  it("derives narration only from real production loop and status payloads", () => {
    expect(
      narrationForTaskEvent(
        "loop:step",
        JSON.stringify({ stepIndex: 10, stepCap: 25, toolName: "run_command" }),
      ),
    ).toBe("Checking the project.");
    expect(narrationForTaskEvent("review_context", "Reviewer context assembled (in_loop).")).toBe(
      "Reviewing the change against the current project.",
    );
    expect(narrationForTaskEvent("tool_call", '{"tool":"unknown"}')).toBeNull();
  });

  it("does not repeat an identical derived line twice in a row", () => {
    let entries: InlineNarrationEntry[] = [];
    entries = appendNarrationEntry(entries, { id: 1, text: "Checking the project." });
    entries = appendNarrationEntry(entries, { id: 2, text: "Checking the project." });
    expect(entries).toEqual([{ id: 1, text: "Checking the project." }]);
  });
});

describe("InlineNarrationStream", () => {
  it("reveals the latest narration word by word while reserving its final height", () => {
    vi.useFakeTimers();

    render(
      <InlineNarrationStream
        live
        entries={[
          { id: 1, text: "I read your project." },
          { id: 2, text: "Now I am planning the smallest safe change." },
        ]}
      />,
    );

    const lines = screen.getAllByTestId("inline-narration-line");
    expect(lines[0]).toHaveTextContent("I read your project.");

    const reservedText = lines[1].querySelector('[aria-hidden="true"].invisible');
    const visibleText = lines[1].querySelector('[aria-hidden="true"].absolute');
    expect(reservedText).toHaveTextContent("Now I am planning the smallest safe change.");
    expect(visibleText).toHaveTextContent(/^Now/);
    expect(visibleText).not.toHaveTextContent("smallest safe change");

    act(() => {
      vi.advanceTimersByTime(38 * 8);
    });

    expect(visibleText).toHaveTextContent("Now I am planning the smallest safe change.");
  });

  it("renders persisted narration immediately when the run is not live", () => {
    render(<InlineNarrationStream entries={[{ id: 8, text: "Quality checks passed." }]} />);

    expect(screen.getByTestId("inline-narration-line")).toHaveTextContent("Quality checks passed.");
  });
});
