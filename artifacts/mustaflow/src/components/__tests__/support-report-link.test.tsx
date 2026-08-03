import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SupportErrorMessage, SupportReportLink } from "../support-report-link";

describe("support report links", () => {
  it("routes error recovery into the in-app support flow", () => {
    render(<SupportErrorMessage message="The action failed." />);

    expect(screen.getByText("The action failed.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report this issue" })).toHaveAttribute(
      "href",
      "/help?mode=report",
    );
  });

  it("allows a surface-specific support label without changing the destination", () => {
    render(<SupportReportLink>Ask support</SupportReportLink>);

    expect(screen.getByRole("link", { name: "Ask support" })).toHaveAttribute(
      "href",
      "/help?mode=report",
    );
  });
});
