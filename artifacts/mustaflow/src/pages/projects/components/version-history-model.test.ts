import { describe, expect, it } from "vitest";
import {
  formatCheckpointClockTime,
  restoreConfirmationMessage,
  versionHistoryDescription,
} from "./version-history-model";

describe("Version History copy", () => {
  it("uses the existing changelog, then note, then prompt as the one-line description", () => {
    expect(
      versionHistoryDescription({
        label: "Build 4",
        changelogEntry: "Added a calmer dashboard.",
        note: "Fallback note",
        triggerMessagePreview: "Fallback prompt",
        filesCount: 7,
      }),
    ).toBe("Added a calmer dashboard.");

    expect(
      versionHistoryDescription({
        label: "Build 3",
        note: "Saved after validation.",
        triggerMessagePreview: "Fallback prompt",
        filesCount: 4,
      }),
    ).toBe("Saved after validation.");
  });

  it("uses the exact plain-language restore confirmation", () => {
    const createdAt = "2026-07-28T15:42:00.000Z";
    expect(formatCheckpointClockTime(createdAt, { locale: "en-US", timeZone: "UTC" })).toBe(
      "3:42 PM",
    );
    expect(restoreConfirmationMessage(createdAt, { locale: "en-US", timeZone: "UTC" })).toBe(
      "Take your app back to how it was at 3:42 PM? Your current version stays saved.",
    );
  });
});
