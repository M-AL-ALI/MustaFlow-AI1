/**
 * Pure-function tests for buildCurrentDateTimeBlock.
 *
 * This is the authoritative "Current date and time" block injected into every
 * Ora system prompt (chat, stream, realtime, file/image analysis) so the model
 * answers today/tomorrow/date-math from a real clock instead of guessing from
 * its training cutoff. Tests inject a fixed `now` for determinism — no clock,
 * no network, no DB.
 */
import { describe, expect, it } from "vitest";
import { buildCurrentDateTimeBlock } from "../prompt";

// A fixed instant: Sunday, 2026-07-05 14:23 UTC (10:23 AM in New York, EDT).
const FIXED_NOW = new Date("2026-07-05T14:23:00Z");

describe("buildCurrentDateTimeBlock", () => {
  it("renders a deterministic UTC date, weekday, and minute-granularity timestamp", () => {
    const block = buildCurrentDateTimeBlock(undefined, FIXED_NOW);
    expect(block).toContain("## Current date and time (authoritative)");
    expect(block).toContain("Sunday");
    expect(block).toContain("July");
    expect(block).toContain("2026");
    expect(block).toContain("14:23");
    // ISO instant is trimmed to minute precision, then suffixed with Z.
    expect(block).toContain("2026-07-05T14:23Z");
  });

  it("always instructs the model never to guess the date from training data", () => {
    const block = buildCurrentDateTimeBlock(undefined, FIXED_NOW);
    expect(block).toContain("Never infer or guess the current date or time");
    expect(block).toContain('"tomorrow"');
  });

  it("adds the user's local time when a valid IANA timezone is supplied", () => {
    const block = buildCurrentDateTimeBlock("America/New_York", FIXED_NOW);
    expect(block).toContain("America/New_York");
    // 14:23 UTC is 10:23 AM EDT.
    expect(block).toContain("10:23");
  });

  it("falls back to a UTC-only note when no timezone is provided", () => {
    const block = buildCurrentDateTimeBlock(undefined, FIXED_NOW);
    expect(block).toContain("local timezone was not provided");
  });

  it("does not throw on an invalid timezone and degrades to the UTC-only note", () => {
    const block = buildCurrentDateTimeBlock("Not/AZone", FIXED_NOW);
    expect(block).toContain("2026-07-05T14:23Z");
    expect(block).toContain("local timezone was not provided");
  });

  it("uses the supplied as-of label (e.g. realtime voice sessions)", () => {
    const block = buildCurrentDateTimeBlock(
      undefined,
      FIXED_NOW,
      "the start of this voice session",
    );
    expect(block).toContain("the start of this voice session");
  });

  it("defaults the as-of label to 'right now'", () => {
    const block = buildCurrentDateTimeBlock(undefined, FIXED_NOW);
    expect(block).toContain("right now");
  });
});
