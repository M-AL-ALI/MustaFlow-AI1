import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WORKSPACE_TOOLS } from "@workspace/nabuflow-workspace-tools";
import { CommandPalette } from "./command-palette";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
const base = { open: true, onClose: vi.fn(), onNavigate: vi.fn(), isPublished: false };
describe("project tool catalog", () => {
  it("has one reading order and all available registry destinations", () => {
    render(<CommandPalette {...base} />);
    expect(screen.getByRole("heading", { name: "Project tools" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(26);
    expect(document.querySelector("[cmdk-list]")).not.toHaveClass("sm:[&_[cmdk-list-sizer]]:grid");
    for (const category of ["All", "Build", "Connect", "Configure", "Protect"]) {
      expect(screen.getByRole("button", { name: category })).toBeInTheDocument();
    }
    expect(screen.queryByText("Analytics")).not.toBeInTheDocument();
  });
  it.each(WORKSPACE_TOOLS)("opens the exact registered destination for $name", async (tool) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...base} isPublished onNavigate={onNavigate} onClose={onClose} />);
    await user.type(screen.getByLabelText("Search project tools"), tool.name);
    await user.click(screen.getByText(tool.name, { exact: true }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(tool.open);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["shell", "Terminal", "terminal"],
    ["logs", "Console output", "logs"],
    ["runtime", "Server", "runtime"],
    ["image studio", "Images", "images"],
  ])("retains the %s search alias", async (query, label, tabId) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<CommandPalette {...base} onNavigate={onNavigate} />);
    await user.type(screen.getByLabelText("Search project tools"), query);
    await user.click(screen.getByText(label));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "workspace-tab", tabId });
  });
  it("filters categories and returns focus to search", async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...base} />);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.queryByText("Preview", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search project tools")).toHaveFocus();
    await user.type(screen.getByLabelText("Search project tools"), "shell");
    expect(screen.getByText("No matching tools in Connect.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Terminal", { exact: true })).toBeInTheDocument();
  });
  it("opens a filtered result with Enter and closes once", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...base} onNavigate={onNavigate} onClose={onClose} />);
    await user.type(screen.getByLabelText("Search project tools"), "secrets");
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "workspace-tab", tabId: "secrets" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("closes once on Escape without navigating", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(<CommandPalette {...base} onClose={onClose} onNavigate={onNavigate} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("resets a previous query and category when reopened", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CommandPalette {...base} />);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.type(screen.getByLabelText("Search project tools"), "database");
    rerender(<CommandPalette {...base} open={false} />);
    rerender(<CommandPalette {...base} />);
    expect(screen.getByLabelText("Search project tools")).toHaveValue("");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("option")).toHaveLength(26);
  });
  it("does not reveal Analytics through search before publishing", async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...base} />);
    await user.type(screen.getByLabelText("Search project tools"), "analytics");
    expect(screen.queryByText("Analytics")).not.toBeInTheDocument();
    expect(screen.getByText("No matching tools.")).toBeInTheDocument();
  });
});

function CatalogFocusHarness({
  onNavigate,
}: {
  onNavigate: (target: import("@workspace/nabuflow-workspace-tools").WorkspaceToolOpen) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open review tools
      </button>
      <CommandPalette
        open={open}
        onClose={() => setOpen(false)}
        onNavigate={onNavigate}
        isPublished={false}
      />
    </>
  );
}

describe("catalog focus lifecycle", () => {
  it("restores the launcher after Escape", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<CatalogFocusHarness onNavigate={onNavigate} />);
    const launcher = screen.getByRole("button", { name: "Open review tools" });
    await user.click(launcher);
    expect(screen.getByLabelText("Search project tools")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("restores the launcher after opening a selected tool", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<CatalogFocusHarness onNavigate={onNavigate} />);
    const launcher = screen.getByRole("button", { name: "Open review tools" });
    await user.click(launcher);
    await user.type(screen.getByLabelText("Search project tools"), "secrets");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(launcher).toHaveFocus());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "workspace-tab", tabId: "secrets" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("describes tool search rather than claiming individual-file search", () => {
    render(<CommandPalette {...base} />);
    expect(screen.getByLabelText("Search project tools")).toHaveAttribute(
      "placeholder",
      "Search tools: database, shell, images...",
    );
  });
});
