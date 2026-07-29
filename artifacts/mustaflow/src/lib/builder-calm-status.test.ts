import { describe, expect, it } from "vitest";
import {
  CALM_STATUS_VOCABULARY,
  calmPhaseForTaskEvent,
  getCalmBuilderStatus,
} from "./builder-calm-status";

describe("builder calm status", () => {
  it("uses the exact beginner-facing vocabulary", () => {
    expect(CALM_STATUS_VOCABULARY).toEqual({
      idle: "Ready for your next change.",
      answering: "Answering your question...",
      planning: "Planning your app...",
      building: "Building your app...",
      images: "Creating images for your app...",
      testing: "Testing what I built...",
      fixing: "Fixing an issue I found...",
    });
    expect(getCalmBuilderStatus({ phase: "building", fileCount: 12 })).toBe(
      "Building — 12 files so far",
    );
  });

  it("collapses internal task events into one calm phase", () => {
    expect(calmPhaseForTaskEvent("file_diff")).toBe("building");
    expect(calmPhaseForTaskEvent("command_output")).toBe("testing");
    expect(calmPhaseForTaskEvent("review_context")).toBe("testing");
    expect(calmPhaseForTaskEvent("narration", "Repairing the preview now")).toBe("fixing");
    expect(calmPhaseForTaskEvent("completed")).toBe("idle");
  });
});
