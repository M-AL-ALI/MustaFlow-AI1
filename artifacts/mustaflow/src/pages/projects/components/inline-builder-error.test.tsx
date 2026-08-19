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

  it("offers one plain production-format recovery action without builder jargon", () => {
    const convertAndBuild = vi.fn();
    const { container } = render(
      <InlineBuilderError
        message="This website needs to be converted to the supported production format before it can build."
        suggestions={[
          "Convert the project to the supported production website format and build it again.",
        ]}
        recoveryAction={{
          label: "Convert and build",
          prompt:
            "Convert this project to the supported production website format, keep its requested design and content, and build it again.",
        }}
        onTryFix={convertAndBuild}
      />,
    );

    expect(
      screen.getByText(/needs to be converted to the supported production format/i),
    ).toBeVisible();
    expect(screen.queryByText("Try this")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Convert and build" }));
    expect(convertAndBuild).toHaveBeenCalledTimes(1);
    expect(convertAndBuild).toHaveBeenCalledWith(
      "Convert this project to the supported production website format, keep its requested design and content, and build it again.",
    );
    expect(container.textContent).not.toMatch(/sealed|zero|node api|vite|stack|runtime|manifest/iu);
  });
});
