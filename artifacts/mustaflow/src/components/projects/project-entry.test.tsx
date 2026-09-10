import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectEntry } from "./project-entry";

afterEach(cleanup);
const props = () => ({
  prompt: "A booking app",
  onPromptChange: vi.fn(),
  onContinue: vi.fn(),
  onBrainstorm: vi.fn(),
  onTemplates: vi.fn(),
  onGuide: vi.fn(),
});
describe("Public project entry", () => {
  it("does not open guidance or start a build just by rendering", () => {
    const input = props();
    render(<ProjectEntry {...input} />);
    expect(input.onGuide).not.toHaveBeenCalled();
    expect(input.onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Help me choose a starting point" }));
    expect(input.onGuide).toHaveBeenCalledOnce();
  });
  it("uses the shared mobile handoff and preserves the entered idea", () => {
    const input = props();
    render(<ProjectEntry {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(input.onContinue).toHaveBeenCalledWith("A booking app", "mobile");
    expect(input.onPromptChange).not.toHaveBeenCalled();
  });
  it("offers explicit brainstorming and honest template expansion state", () => {
    const input = props();
    const { rerender } = render(<ProjectEntry {...input} />);
    const templates = screen.getByRole("button", { name: "Explore templates" });
    expect(templates.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(templates);
    expect(input.onTemplates).toHaveBeenCalledOnce();
    rerender(<ProjectEntry {...input} templatesOpen />);
    expect(
      screen.getByRole("button", { name: "Hide templates" }).getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Brainstorm first" }));
    expect(input.onBrainstorm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Attach a file" })).toBeNull();
  });
});
