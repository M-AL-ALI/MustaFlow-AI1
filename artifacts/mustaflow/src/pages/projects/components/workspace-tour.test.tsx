import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTour, useCompleteWorkspaceTourOnBuild } from "./workspace-tour";

function BuildLifecycleHarness({ projectId, statuses }: { projectId: number; statuses: string[] }) {
  const [active, setActive] = useState(true);
  useCompleteWorkspaceTourOnBuild({
    projectId,
    taskStatuses: statuses,
    onComplete: () => setActive(false),
  });
  return <div>{active ? "Tour active" : "Tour closed"}</div>;
}

describe("WorkspaceTour", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<button data-tour="chat-input">Composer</button>';
  });

  it("keeps the transparent target overlay non-interactive while the tour is active", async () => {
    render(<WorkspaceTour active onClose={vi.fn()} />);

    const targetOverlay = await screen.findByTestId("workspace-tour-target-overlay");
    expect(targetOverlay).toHaveClass("pointer-events-none");
    expect(targetOverlay).not.toHaveAttribute("onClick");
    expect(screen.getByTestId("workspace-tour-overlay")).toHaveStyle({ pointerEvents: "none" });
  });

  it("advances and dismisses through explicit tour controls", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WorkspaceTour active onClose={onClose} />);

    expect(screen.getByText("1 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes and marks the tour seen when a build starts", async () => {
    const projectId = 42;
    const { rerender } = render(
      <BuildLifecycleHarness projectId={projectId} statuses={["queued"]} />,
    );

    expect(screen.getByText("Tour active")).toBeInTheDocument();
    expect(localStorage.getItem(`mustaflow_tour_seen_${projectId}`)).toBeNull();

    rerender(<BuildLifecycleHarness projectId={projectId} statuses={["building"]} />);

    await waitFor(() => expect(screen.getByText("Tour closed")).toBeInTheDocument());
    expect(localStorage.getItem(`mustaflow_tour_seen_${projectId}`)).toBe("1");
  });
});
