import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { WorkingAnchor } from "./working-anchor";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe("WorkingAnchor", () => {
  it("always names Zero and the current real phase", () => {
    render(
      <WorkingAnchor
        activity={{ id: 4, kind: "writing", label: "Writing code" }}
        density="standard"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Zero is working");
    expect(screen.getByRole("status")).toHaveTextContent("Writing code");
  });

  it("shows exact loop progress by default only at Pro density", () => {
    const { rerender } = render(
      <WorkingAnchor
        activity={{ id: 4, kind: "writing", label: "Writing code" }}
        density="minimal"
        progress={{ stepIndex: 4, stepCap: 25 }}
      />,
    );
    expect(screen.queryByTestId("working-anchor-progress")).not.toBeInTheDocument();

    rerender(
      <WorkingAnchor
        activity={{ id: 4, kind: "writing", label: "Writing code" }}
        density="detailed"
        progress={{ stepIndex: 4, stepCap: 25 }}
      />,
    );
    expect(screen.getByTestId("working-anchor-progress")).toHaveTextContent("step 4 of 25");
  });
});
