import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchitectReviewCard } from "./chat-history";

function review(creditsCharged?: number) {
  return {
    verdict: "partial" as const,
    summary: "The migration needs one more verification pass.",
    findings: [],
    nextActions: [],
    autoFixQueued: false,
    reviewedAt: "2026-07-30T15:48:26.254Z",
    model: "gpt-5-mini",
    ...(creditsCharged === undefined ? {} : { creditsCharged }),
  };
}

async function renderExpanded(creditsCharged?: number) {
  const user = userEvent.setup();
  render(<ArchitectReviewCard review={review(creditsCharged)} />);
  await user.click(screen.getByTestId("architect-review-toggle"));
}

describe("architect review credit honesty", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  });

  it("renders no charge claim when the persisted actual charge is zero", async () => {
    await renderExpanded(0);

    expect(screen.queryByText(/credits charged/i)).not.toBeInTheDocument();
    expect(screen.getByText("gpt-5-mini")).toBeVisible();
  });

  it("renders no charge claim when legacy report data has no charge value", async () => {
    await renderExpanded();

    expect(screen.queryByText(/credits charged/i)).not.toBeInTheDocument();
    expect(screen.getByText("gpt-5-mini")).toBeVisible();
  });

  it("keeps the existing non-zero wording unchanged", async () => {
    await renderExpanded(2);

    expect(screen.getByText("2 credits charged · gpt-5-mini")).toBeVisible();
  });
});
