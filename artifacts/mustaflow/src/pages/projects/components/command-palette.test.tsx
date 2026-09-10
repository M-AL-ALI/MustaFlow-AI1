import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./command-palette";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

describe("Command Center", () => {
  it("shows the registry categories and opens a selected tool", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<CommandPalette open onClose={vi.fn()} onNavigate={onNavigate} isPublished={false} />);

    for (const category of ["Build", "Connect", "Configure", "Protect"]) {
      expect(screen.getByText(category)).toBeInTheDocument();
    }
    expect(document.querySelector("[cmdk-list]")).toHaveClass(
      "sm:[&_[cmdk-list-sizer]]:grid",
      "sm:[&_[cmdk-list-sizer]]:grid-cols-2",
    );
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Analytics")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Search project tools"), "secret");
    expect(document.querySelector("[cmdk-list]")).not.toHaveClass("sm:[&_[cmdk-list-sizer]]:grid");
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("Page map")).not.toBeInTheDocument();
    await user.click(screen.getByText("Secrets"));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "workspace-tab", tabId: "secrets" });
  });

  it("includes published-only tools when the project is live", () => {
    render(<CommandPalette open onClose={vi.fn()} onNavigate={vi.fn()} isPublished />);
    expect(screen.getByText("Analytics")).toBeInTheDocument();
  });
});

describe("Command Center search aliases", () => {
  it.each([
    ["shell", "Terminal", "terminal"],
    ["logs", "Console output", "logs"],
    ["runtime", "Server", "runtime"],
    ["image studio", "Images", "images"],
  ])("opens %s using its existing destination", async (query, label, tabId) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} onNavigate={onNavigate} isPublished={false} />);
    await user.type(screen.getByLabelText("Search project tools"), query);
    await user.click(screen.getByText(label));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "workspace-tab", tabId });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("does not surface Analytics through search before publishing", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onClose={vi.fn()} onNavigate={vi.fn()} isPublished={false} />);
    await user.type(screen.getByLabelText("Search project tools"), "analytics");
    expect(screen.queryByText("Analytics")).not.toBeInTheDocument();
    expect(screen.getByText(/No matching tools/)).toBeInTheDocument();
  });
});
