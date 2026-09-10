import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectToolsLoading } from "./project-tools-loading";

describe("project tools loading feedback", () => {
  it("announces pending loading and lets the user cancel without navigation", async () => {
    const cancel = vi.fn();
    render(<ProjectToolsLoading onCancel={cancel} />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening project tools...");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
