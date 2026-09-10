import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityLogTab } from "./activity-log-tab";
vi.mock("@/lib/api-fetch", () => ({
  authFetch: (input: string, init?: RequestInit) => fetch(input, init),
}));

describe("Builder activity log", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads and renders a completed task's persisted event", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: -901,
            actorName: "Agent Zero",
            eventType: "build",
            summary:
              "Built 15 files — reached the step limit; you can continue with a follow-up prompt.",
            metadata: {
              source: "task_event",
              taskId: 110,
              taskEventType: "completed",
            },
            createdAt: new Date().toISOString(),
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    render(<ActivityLogTab projectId={42} />);

    expect(
      await screen.findByText(
        "Built 15 files — reached the step limit; you can continue with a follow-up prompt.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("by Agent Zero")).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/42/activity-log?limit=100",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

const activityFixture = (summary: string, eventType = "build_failed") => ({
  id: -315,
  actorName: "Agent Zero",
  eventType,
  summary,
  metadata: { taskId: 315 },
  createdAt: "2026-09-10T13:48:04.797Z",
});
const activityResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("Activity failure and scope recovery", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each([401, 403, 404, 500])(
    "does not misrepresent HTTP %s as an empty project",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(activityResponse({}, status));
      render(<ActivityLogTab projectId={61} />);
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    },
  );
  it.each([null, {}, [{ id: 1, summary: "incomplete" }]])(
    "rejects malformed successful data: %j",
    async (data) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(activityResponse(data));
      render(<ActivityLogTab projectId={61} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load project activity");
    },
  );
  it("recovers a network failure without losing the failed build receipt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(activityResponse([activityFixture("Compatibility repair required")]));
    render(<ActivityLogTab projectId={61} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Compatibility repair required")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("discards a late response after switching projects", async () => {
    let finishOld!: (response: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(activityResponse([activityFixture("Project 62 activity")]));
    const view = render(<ActivityLogTab projectId={61} />);
    view.rerender(<ActivityLogTab projectId={62} />);
    expect(await screen.findByText("Project 62 activity")).toBeInTheDocument();
    await act(async () => {
      finishOld(activityResponse([activityFixture("Private project 61 activity")]));
    });
    expect(screen.queryByText("Private project 61 activity")).not.toBeInTheDocument();
    expect(screen.getByText("Project 62 activity")).toBeInTheDocument();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });
  it("fences a late filter result and exposes a failed-build filter", async () => {
    let finishAll!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishAll = resolve;
          }),
      )
      .mockResolvedValueOnce(activityResponse([]));
    render(<ActivityLogTab projectId={61} />);
    fireEvent.click(screen.getByRole("button", { name: "Failed builds" }));
    expect(await screen.findByText("No matching activity")).toBeInTheDocument();
    await act(async () => {
      finishAll(activityResponse([activityFixture("An unrelated event", "publish")]));
    });
    expect(screen.queryByText("An unrelated event")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Failed builds" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("bounds a stalled request and shows retry instead of a permanent spinner", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    render(<ActivityLogTab projectId={61} />);
    expect(screen.getByRole("status", { name: "Loading activity" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load project activity");
    expect(screen.getByRole("button", { name: "Refresh activity" })).toBeEnabled();
  });
});
