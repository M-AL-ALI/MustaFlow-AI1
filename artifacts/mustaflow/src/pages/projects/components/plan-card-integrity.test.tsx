import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@workspace/api-client-react", () => ({
  useListSecrets: () => ({ data: [] }),
  getListSecretsQueryKey: () => ["secrets"],
}));
vi.mock("@/lib/builder-followup-submit", () => ({
  useBuilderCreditCosts: () => ({ standard: { lite: 1, eco: 2, power: 3, pro: 4 } }),
}));
vi.mock("./plan-decompose", () => ({ PlanDecomposeView: () => null }));
vi.mock("./plan-history", () => ({ PlanHistoryPanel: () => null }));
import { PlanCard, type StructuredPlan } from "./plan-card";
const build = vi.fn();
const props = { projectId: 61, initialAgentMode: "eco" as const, disabled: false, onBuild: build };
const plan = (name: string) => ({ goal: name, approach: `Implement ${name}`, pages: ["Notes"] });
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  localStorage.clear();
  build.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("plan card artifact integrity", () => {
  it("never offers execution for metadata-only plans, even with old persisted edits", () => {
    localStorage.setItem(
      "plan_edits_842",
      JSON.stringify({ goal: "Old goal", approach: "Unsafe old approach" }),
    );
    render(<PlanCard {...props} messageId={842} plan={{ intent: "plan" } as StructuredPlan} />);
    expect(screen.getByText("Plan unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build now" })).not.toBeInTheDocument();
    expect(screen.queryByText("Old goal")).not.toBeInTheDocument();
  });
  it("switches to the new message without copying old edits or pending saves", () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "plan_edits_838",
      JSON.stringify({ goal: "Edited old goal", approach: "Old local approach" }),
    );
    const view = render(<PlanCard {...props} messageId={838} plan={plan("Old goal")} />);
    expect(screen.getByText("Edited old goal")).toBeInTheDocument();
    view.rerender(<PlanCard {...props} messageId={843} plan={plan("New goal")} />);
    expect(screen.getByText("New goal")).toBeInTheDocument();
    expect(screen.queryByText("Edited old goal")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(JSON.parse(localStorage.getItem("plan_edits_843")!).goal).toBe("New goal");
    fireEvent.click(screen.getByRole("button", { name: "Build now" }));
    expect(build).toHaveBeenCalledWith(expect.stringContaining("Goal: New goal"), "eco", false);
    expect(build.mock.calls[0]![0]).not.toContain("Old local approach");
  });
  it("replaces a valid card with an honest unavailable state", () => {
    const view = render(<PlanCard {...props} messageId={838} plan={plan("Old goal")} />);
    view.rerender(<PlanCard {...props} messageId={842} plan={null} />);
    expect(screen.getByText("Plan unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Build now" })).not.toBeInTheDocument();
  });
});
