import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InlineBuilderError } from "./inline-builder-error";

describe("InlineBuilderError", () => {
  it("states what broke and keeps the recovery action beside it without card chrome", () => {
    const tryFix = vi.fn();
    const { container } = render(
      <InlineBuilderError
        message="The preview could not start because port 3000 was unavailable."
        suggestions={["Use the configured preview port and start the app again."]}
        onTryFix={tryFix}
      />,
    );

    expect(screen.getByText("I couldn't finish this step.")).toBeVisible();
    expect(screen.getByText(/port 3000 was unavailable/)).toBeVisible();
    fireEvent.click(screen.getByText("Try this"));
    expect(tryFix).toHaveBeenCalledWith("Use the configured preview port and start the app again.");
    expect(container.firstElementChild).not.toHaveClass(
      "border",
      "bg-destructive/10",
      "rounded-xl",
    );
  });
});
