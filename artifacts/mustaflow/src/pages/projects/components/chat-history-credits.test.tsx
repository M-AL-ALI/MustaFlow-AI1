import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NabuflowUsageEvent } from "@workspace/api-client-react";
import { ArchitectReviewCard, architectCreditsFromLedger } from "./chat-history";

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

async function renderExpanded(reportCredits?: number, actualLedgerCredits?: number) {
  const user = userEvent.setup();
  render(
    <ArchitectReviewCard
      review={review(reportCredits)}
      actualCreditsCharged={actualLedgerCredits}
    />,
  );
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
    await renderExpanded(999, 0);

    expect(screen.queryByText(/credits charged/i)).not.toBeInTheDocument();
    expect(screen.getByText("gpt-5-mini")).toBeVisible();
  });

  it("renders no charge claim when the ledger has no matching charge", async () => {
    await renderExpanded(999);

    expect(screen.queryByText(/credits charged/i)).not.toBeInTheDocument();
    expect(screen.getByText("gpt-5-mini")).toBeVisible();
  });

  it("renders ledger truth when a legacy report claim disagrees", async () => {
    await renderExpanded(999, 2);

    expect(screen.getByText("2 credits charged · gpt-5-mini")).toBeVisible();
    expect(screen.queryByText(/999 credits charged/i)).not.toBeInTheDocument();
  });

  it("derives the displayed amount only from live, matching architect ledger rows", () => {
    const event = (
      id: number,
      taskId: number,
      source: string,
      credits: number,
      reversedAt: string | null = null,
    ) =>
      ({
        id,
        taskId,
        source,
        credits,
        reversedAt,
      }) as NabuflowUsageEvent;

    expect(
      architectCreditsFromLedger(
        [
          event(1, 44, "architect", 2),
          event(2, 44, "pipeline", 160),
          event(3, 45, "architect", 2),
          event(4, 44, "architect", 2, "2026-07-30T16:00:00.000Z"),
        ],
        44,
      ),
    ).toBe(2);
  });
});
