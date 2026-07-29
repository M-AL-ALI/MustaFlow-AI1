import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  distanceFromBottom,
  isNearChatBottom,
  JumpToLatestButton,
  nextChatFollowState,
  scrollChatToLatest,
} from "./smart-auto-scroll";

describe("smart chat following", () => {
  it("stops following immediately when the user scrolls upward", () => {
    expect(
      nextChatFollowState({
        wasFollowing: true,
        previousScrollTop: 500,
        metrics: { scrollHeight: 900, scrollTop: 499, clientHeight: 380 },
      }),
    ).toBe(false);
  });

  it("does not resume until the user returns to the bottom", () => {
    expect(
      nextChatFollowState({
        wasFollowing: false,
        previousScrollTop: 420,
        metrics: { scrollHeight: 900, scrollTop: 430, clientHeight: 450 },
      }),
    ).toBe(false);
    expect(
      nextChatFollowState({
        wasFollowing: false,
        previousScrollTop: 430,
        metrics: { scrollHeight: 900, scrollTop: 450, clientHeight: 450 },
      }),
    ).toBe(true);
  });

  it("calculates and reaches the latest position", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      scrollHeight: { value: 900, configurable: true },
      clientHeight: { value: 450, configurable: true },
      scrollTop: { value: 100, writable: true, configurable: true },
    });

    expect(distanceFromBottom(element)).toBe(350);
    expect(isNearChatBottom(element)).toBe(false);

    scrollChatToLatest(element);
    expect(element.scrollTop).toBe(900);
  });
});

describe("JumpToLatestButton", () => {
  it("returns control to the user on demand", () => {
    const onJump = vi.fn();
    render(<JumpToLatestButton busy onJump={onJump} />);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest activity" }));

    expect(onJump).toHaveBeenCalledOnce();
    expect(screen.getByText("New activity")).toBeVisible();
  });
});
