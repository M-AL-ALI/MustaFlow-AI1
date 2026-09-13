// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SavedFailedBuilds, type SavedFailedBuildTask } from "./saved-failed-builds";

const request =
  "Keep the complete English and Arabic notebook request, including backend persistence.";
const saved = (overrides: Partial<SavedFailedBuildTask> = {}): SavedFailedBuildTask => ({
  id: 321,
  projectId: 61,
  status: "failed",
  prompt: request,
  stagingSnapshot: [{ path: "src/index.ts", content: "export {};" }],
  appliedAt: null,
  discardedAt: null,
  completedAt: "2026-09-13T01:07:02.498Z",
  ...overrides,
});

afterEach(cleanup);

describe("Saved failed builds", () => {
  it("only reviews the exact full request and source ID after a click", () => {
    const onReview = vi.fn();
    render(<SavedFailedBuilds projectId={61} tasks={[saved()]} onReview={onReview} />);
    expect(screen.getByText(request).getAttribute("dir")).toBe("auto");
    fireEvent.click(screen.getByText("Full request for build #321"));
    expect(onReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review build #321 in composer" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(request, 321);
  });

  it("can recover an exact multilingual report request without a title fallback", () => {
    const full =
      "English request \u0627\u0644\u0639\u0631\u0628\u064a\u0629\nKeep the final requirement.";
    const onReview = vi.fn();
    render(
      <SavedFailedBuilds
        projectId={61}
        tasks={[saved({ prompt: " ", report: { userRequest: full } })]}
        onReview={onReview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review build #321 in composer" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(full, 321);
  });

  it.each([
    { projectId: 62 },
    { projectId: undefined },
    { id: -1 },
    { id: 1.5 },
    { status: "completed" },
    { status: "needs_review" },
    { status: "discarded" },
    { stagingSnapshot: [] },
    { stagingSnapshot: [{ content: "no path" }] },
    { appliedAt: "2026-09-13T01:00:00Z" },
    { discardedAt: "2026-09-13T01:00:00Z" },
  ])("does not offer an unrelated or unavailable draft: %j", (override) => {
    render(<SavedFailedBuilds projectId={61} tasks={[saved(override)]} onReview={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Review build/ })).toBeNull();
  });

  it.each([{ appliedAt: undefined }, { discardedAt: undefined }, { prompt: null, report: {} }])(
    "disables review if complete state or full request is missing: %j",
    (override) => {
      const onReview = vi.fn();
      render(<SavedFailedBuilds projectId={61} tasks={[saved(override)]} onReview={onReview} />);
      const button = screen.getByRole("button", {
        name: "Review build #321 in composer",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(onReview).not.toHaveBeenCalled();
    },
  );

  it("excludes a source already used by a same-project retry but not another project", () => {
    const child = saved({
      id: 322,
      status: "queued",
      stagingSnapshot: null,
      report: { retrySource: { taskId: 321 } },
    });
    const { rerender } = render(
      <SavedFailedBuilds projectId={61} tasks={[saved(), child]} onReview={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /Review build/ })).toBeNull();
    rerender(
      <SavedFailedBuilds
        projectId={61}
        tasks={[saved(), { ...child, projectId: 62 }]}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Review build #321 in composer" })).toBeTruthy();
  });

  it("fails closed on query failure instead of offering stale data or reporting no drafts", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <SavedFailedBuilds
        projectId={61}
        tasks={[saved()]}
        error
        onRefresh={onRefresh}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/could not be refreshed/);
    expect(screen.queryByRole("button", { name: /Review build/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved builds" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<SavedFailedBuilds projectId={61} tasks={[saved()]} loading onRefresh={onRefresh} />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading saved builds/);
  });

  it("disables stale review during refresh and removes drafts when the result changes", () => {
    const { rerender } = render(
      <SavedFailedBuilds projectId={61} tasks={[saved()]} refreshing onReview={vi.fn()} />,
    );
    expect(
      (screen.getByRole("button", { name: /Review build/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<SavedFailedBuilds projectId={61} tasks={[]} onReview={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Review build/ })).toBeNull();
  });

  it("shows five most recent drafts, allows older drafts, and isolates project changes", () => {
    const tasks = Array.from({ length: 6 }, (_, index) => saved({ id: 321 + index }));
    const { rerender } = render(
      <SavedFailedBuilds projectId={61} tasks={tasks} onReview={vi.fn()} />,
    );
    expect(screen.getAllByRole("button", { name: /Review build/ })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Review build #321 in composer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show older saved builds" }));
    expect(screen.getAllByRole("button", { name: /Review build/ })).toHaveLength(6);
    rerender(<SavedFailedBuilds projectId={62} tasks={tasks} onReview={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Review build/ })).toBeNull();
  });
});
