import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

type CapturedTaskEvent = {
  id: number;
  taskId: number;
  eventType: string;
  message: string;
  data?: unknown;
  createdAt: string;
};

const api = vi.hoisted(() => ({
  events: [] as CapturedTaskEvent[],
  useListTaskEvents: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListTaskEventsQueryKey: (projectId: number, taskId: number) => [
    `/api/projects/${projectId}/tasks/${taskId}/events`,
  ],
  useListTaskEvents: api.useListTaskEvents,
}));

import { buildRunReplayModel, PersistedRunReplay } from "./inline-run-group";

function loadProductionTask140(): CapturedTaskEvent[] {
  const fixturePath = resolve(
    process.cwd(),
    "../../docs/evidence/wave-d33/production-task-140.sse.gz",
  );
  const raw = gunzipSync(readFileSync(fixturePath)).toString("utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as CapturedTaskEvent);
}

describe("PersistedRunReplay with captured production traffic", () => {
  beforeAll(() => {
    api.events = loadProductionTask140();
    api.useListTaskEvents.mockReturnValue({ data: api.events });
  });

  it("refetches authoritative history and replays the retained live steps in order", () => {
    expect(api.events).toHaveLength(74);
    expect(api.events[0]?.eventType).toBe("queued");
    expect(api.events.at(-1)?.eventType).toBe("completed");

    const replay = buildRunReplayModel(api.events);
    expect(replay.stepCount).toBe(25);
    expect(replay.activities.map((event) => event.id)).toEqual(
      [...replay.activities.map((event) => event.id)].sort((left, right) => left - right),
    );
    expect(replay.narrations.map((event) => event.id)).toEqual(
      [...replay.narrations.map((event) => event.id)].sort((left, right) => left - right),
    );
    expect(replay.qaEvents.map((event) => event.id)).toEqual(
      [...replay.qaEvents.map((event) => event.id)].sort((left, right) => left - right),
    );

    render(<PersistedRunReplay projectId={44} taskId={140} />);

    expect(api.useListTaskEvents).toHaveBeenCalledWith(
      44,
      140,
      expect.objectContaining({
        query: expect.objectContaining({
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnMount: "always",
        }),
      }),
    );
    expect(
      screen.getByText(`${replay.stepCount} steps · expand to replay`),
    ).toBeVisible();

    fireEvent.click(screen.getByTestId("inline-run-toggle"));
    expect(
      screen
        .getAllByTestId("inline-activity-row")
        .map((row) => row.textContent?.trim()),
    ).toEqual(
      replay.activities.map((event) => event.resolvedLabel ?? event.label),
    );
    expect(
      screen
        .getAllByTestId("inline-narration-line")
        .map((row) => row.textContent?.trim()),
    ).toEqual(
      replay.narrations.map((event) => event.text),
    );
    const qaRows = screen.getAllByTestId("qa-tape-step");
    expect(qaRows).toHaveLength(replay.qaEvents.length);
    replay.qaEvents.forEach((event, index) => {
      expect(qaRows[index]).toHaveTextContent(event.message);
    });
  });
});
