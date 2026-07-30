import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildRunReplayModel } from "./inline-run-group";
import { addRunStepId, buildRunStepIdSet, createRunStepIdSet } from "./run-step-count";

type CapturedSseFrame = {
  data: string;
};

type CapturedTaskEvent = {
  id: number;
  taskId: number;
  eventType: string;
  message: string;
  data?: unknown;
  createdAt: string;
};

const TASK_164_CAPTURE_SHA256 = "e96887404ccac2184f164cac2e6d26d2977933d36f4429c4529842d1124f6234";
const TASK_140_CAPTURE_SHA256 = "b6113f0ad80f9caea42e4e2d7a1802cc83917b822fe29d702c38eeb1d7d18aa8";

function loadProductionTask164(): {
  events: CapturedTaskEvent[];
  frameCount: number;
  sha256: string;
} {
  const fixturePath = resolve(
    process.cwd(),
    "../../docs/evidence/wave-d37/production-task-164.sse.jsonl",
  );
  const raw = readFileSync(fixturePath);
  const frames = raw
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapturedSseFrame);

  return {
    events: frames.map((frame) => JSON.parse(frame.data) as CapturedTaskEvent),
    frameCount: frames.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function loadProductionTask140(): {
  events: CapturedTaskEvent[];
  frameCount: number;
  sha256: string;
} {
  const fixturePath = resolve(
    process.cwd(),
    "../../docs/evidence/wave-d33/production-task-140.sse.gz",
  );
  const compressed = readFileSync(fixturePath);
  const events = gunzipSync(compressed)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as CapturedTaskEvent);

  return {
    events,
    frameCount: events.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
  };
}

describe("run step count with captured production traffic", () => {
  it("keeps task 164 live and persisted counts at 28 after completion and reload", () => {
    const capture = loadProductionTask164();

    expect(capture.frameCount).toBe(199);
    expect(capture.sha256).toBe(TASK_164_CAPTURE_SHA256);

    const liveStepIds = createRunStepIdSet();
    const liveCounts = capture.events.map((event) => addRunStepId(liveStepIds, event));
    expect(liveCounts.every((count, index) => index === 0 || count >= liveCounts[index - 1])).toBe(
      true,
    );
    expect(liveStepIds.size).toBe(28);

    const persistedEvents = capture.events.map((event) => ({ ...event }));
    expect(buildRunStepIdSet(persistedEvents).size).toBe(28);
    expect(buildRunReplayModel(persistedEvents).stepCount).toBe(28);

    const reloadedEvents = JSON.parse(JSON.stringify(persistedEvents)) as CapturedTaskEvent[];
    expect(buildRunStepIdSet(reloadedEvents).size).toBe(28);
    expect(buildRunReplayModel(reloadedEvents).stepCount).toBe(28);
  });

  it("keeps the 74-frame task 140 capture at 25 steps", () => {
    const capture = loadProductionTask140();

    expect(capture.frameCount).toBe(74);
    expect(capture.sha256).toBe(TASK_140_CAPTURE_SHA256);
    expect(buildRunStepIdSet(capture.events).size).toBe(25);
    expect(buildRunReplayModel(capture.events).stepCount).toBe(25);
  });
});
