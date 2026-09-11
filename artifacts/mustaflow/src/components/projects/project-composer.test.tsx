import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectComposer } from "./project-composer";
import { savePublicCreationDraft } from "@/lib/creation-draft";

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
const props = () => ({
  prompt: "A booking app",
  onPromptChange: vi.fn(),
  onContinue: vi.fn(),
  onBrainstorm: vi.fn(),
});

describe("Project composer", () => {
  it("uses the scoped platform prop and never reads an unrelated public draft", () => {
    savePublicCreationDraft({ intent: "build", prompt: "A booking app", platform: "mobile" });
    const first = render(<ProjectComposer {...props()} />);
    expect(screen.getByRole("button", { name: "Web" })).toHaveAttribute("aria-pressed", "true");
    first.rerender(<ProjectComposer {...props()} platform="mobile" />);
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
  });
  it("reports platform changes to its owning workspace even with an empty prompt", () => {
    const onPlatformChange = vi.fn();
    render(
      <ProjectComposer
        {...props()}
        prompt=""
        platform="mobile"
        onPlatformChange={onPlatformChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Web" }));
    expect(onPlatformChange).toHaveBeenCalledWith("web");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
  it("blocks oversized briefs for both the button and keyboard handoff", () => {
    const input = props();
    render(<ProjectComposer {...input} prompt={"x".repeat(20001)} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(input.onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("20,000 characters");
  });
  it("does not submit an enclosing form when selecting an example", () => {
    const onSubmit = vi.fn((event) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ProjectComposer {...props()} />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("continues with the selected platform without creating a project itself", () => {
    const input = props();
    render(<ProjectComposer {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(input.onContinue).toHaveBeenCalledWith("A booking app", "mobile");
  });
  it("opens brainstorming, instead of showing a nonfunctional Plan toggle", () => {
    const input = props();
    render(<ProjectComposer {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Brainstorm first" }));
    expect(input.onBrainstorm).toHaveBeenCalledOnce();
    expect(input.onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
  });
  it("supports multiline text, an explicit shortcut, and IME composition", () => {
    const input = props();
    render(<ProjectComposer {...input} />);
    const text = screen.getByRole("textbox", { name: "Describe your app" });
    fireEvent.keyDown(text, { key: "Enter" });
    expect(input.onContinue).not.toHaveBeenCalled();
    fireEvent.keyDown(text, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(input.onContinue).not.toHaveBeenCalled();
    fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
    expect(input.onContinue).toHaveBeenCalledOnce();
  });
  it("keeps Arabic text intact and uses automatic direction without claiming agent language proof", () => {
    const input = props();
    const text = "\u062a\u0637\u0628\u064a\u0642 \u062d\u062c\u0632";
    render(<ProjectComposer {...input} prompt={text} />);
    expect(screen.getByRole("textbox").getAttribute("dir")).toBe("auto");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(input.onContinue).toHaveBeenCalledWith(text, "web");
  });
  it("disables unavailable voice input and empty submissions", () => {
    render(
      <ProjectComposer
        {...props()}
        prompt="  "
        voice={{ supported: false, recording: false, language: "en-US", toggle: vi.fn() }}
      />,
    );
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Start voice input" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("Project composer example protection", () => {
  const booking =
    "A booking app for my small business, with appointments, customers, and reminders.";

  it("fills an empty draft immediately without starting a build", () => {
    const input = props();
    render(<ProjectComposer {...input} prompt="  " />);
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    expect(input.onPromptChange).toHaveBeenCalledExactlyOnceWith(booking);
    expect(input.onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Replace your current idea?" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Describe your app" })).toHaveFocus();
  });

  it("preserves the original brief and focuses the safe choice before replacement", () => {
    const input = props();
    render(<ProjectComposer {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    expect(input.onPromptChange).not.toHaveBeenCalled();
    expect(input.onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue(input.prompt);
    expect(screen.getByRole("group", { name: "Replace your current idea?" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Use a booking app instead?");
    expect(screen.getByRole("button", { name: "Keep my idea" })).toHaveFocus();
    expect(screen.getByText(booking)).toBeVisible();
  });

  it("keeps the brief intact when the user declines the example", () => {
    const input = props();
    render(<ProjectComposer {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "A personal website" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep my idea" }));
    expect(input.onPromptChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue(input.prompt);
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Replace your current idea?" })).toBeNull();
    expect(screen.getByRole("button", { name: "A booking app" })).toBeVisible();
  });

  it("lets Escape cancel the proposal without accepting text or starting a build", () => {
    const input = props();
    render(<ProjectComposer {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "A team dashboard" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep my idea" }), { key: "Escape" });
    expect(input.onPromptChange).not.toHaveBeenCalled();
    expect(input.onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Replace your current idea?" })).toBeNull();
  });

  it("does not handle Escape during IME composition as a replacement decision", () => {
    render(<ProjectComposer {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep my idea" }), {
      key: "Escape",
      isComposing: true,
    });
    expect(screen.getByRole("group", { name: "Replace your current idea?" })).toBeVisible();
  });

  it("replaces only after an explicit decision, without submitting an enclosing form", () => {
    const input = props();
    const onSubmit = vi.fn((event) => event.preventDefault());
    const onPlatformChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <ProjectComposer {...input} platform="mobile" onPlatformChange={onPlatformChange} />
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace with example" }));
    expect(input.onPromptChange).toHaveBeenCalledExactlyOnceWith(booking);
    expect(input.onContinue).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onPlatformChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("discards a stale proposal when the owning draft changes, including A to B to A", () => {
    const input = props();
    const rendered = render(<ProjectComposer {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    rendered.rerender(<ProjectComposer {...input} prompt="A newer notebook brief" />);
    expect(screen.queryByRole("button", { name: "Replace with example" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("A newer notebook brief");
    rendered.rerender(<ProjectComposer {...input} />);
    expect(screen.queryByRole("button", { name: "Replace with example" })).toBeNull();
    expect(input.onPromptChange).not.toHaveBeenCalled();
  });

  it("does not mix the proposed example into a keyboard continuation of the original brief", () => {
    const input = props();
    render(<ProjectComposer {...input} platform="mobile" />);
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(input.onContinue).toHaveBeenCalledExactlyOnceWith(input.prompt, "mobile");
    expect(input.onPromptChange).not.toHaveBeenCalled();
  });

  it("keeps Arabic and mixed-language drafts unchanged when offering an English example", () => {
    const input = props();
    const arabic = "\u0645\u0644\u0627\u062d\u0638\u0627\u062a English + Arabic";
    render(<ProjectComposer {...input} prompt={arabic} />);
    fireEvent.click(screen.getByRole("button", { name: "A team dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep my idea" }));
    expect(screen.getByRole("textbox")).toHaveValue(arabic);
    expect(input.onPromptChange).not.toHaveBeenCalled();
  });

  it("does not request replacement when the draft already equals that example", () => {
    const input = props();
    render(<ProjectComposer {...input} prompt={booking} />);
    fireEvent.click(screen.getByRole("button", { name: "A booking app" }));
    expect(screen.queryByRole("group", { name: "Replace your current idea?" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(input.onContinue).not.toHaveBeenCalled();
  });
});
