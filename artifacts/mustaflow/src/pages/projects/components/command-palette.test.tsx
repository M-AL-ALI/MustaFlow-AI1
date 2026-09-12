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

describe("ranked tool keyboard navigation", () => {
  it.each(WORKSPACE_TOOLS)(
    "opens exact name $name with Enter rather than a description match",
    async (tool) => {
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const onClose = vi.fn();
      render(<CommandPalette {...base} isPublished onNavigate={onNavigate} onClose={onClose} />);
      await user.type(screen.getByLabelText("Search project tools"), tool.name);
      await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveTextContent(tool.name));
      await user.keyboard("{Enter}");
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith(tool.open);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );
  it("retains relevance across category groups and supports deliberate secondary selection", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<CommandPalette {...base} onNavigate={onNavigate} />);
    await user.type(screen.getByLabelText("Search project tools"), "server");
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveTextContent("Server"));
    expect(screen.getByText("Search results", { exact: true })).toBeInTheDocument();
    await user.click(screen.getByText("Console output", { exact: true }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "workspace-tab", tabId: "logs" });
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
      "Search tools in English or Arabic...",
    );
  });
});

describe("bilingual tool catalog interactions", () => {
  it.each([
    [
      "\u0642\u064e\u0627\u0639\u0650\u062f\u064e\u0629 \u0627\u0644\u0628\u064e\u064a\u064e\u0627\u0646\u064e\u0627\u062a",
      "Database",
      "database",
    ],
    [
      "\u062e\u0631\u064a\u0637\u0629 \u0627\u0644\u0635\u0641\u062d\u0627\u062a",
      "Page map",
      "page-map",
    ],
    ["\u0645\u0641\u0627\u062a\u064a\u062d \u0623\u0633\u0631\u0627\u0631", "Secrets", "secrets"],
    ["\u0628\u064a\u0627\u0646\u0627\u062a database", "Database", "database"],
    ["tables SQL", "Database", "database"],
    ["\uff33\uff28\uff25\uff2c\uff2c", "Terminal", "terminal"],
  ])("opens %s through the same registered tool", async (query, label, tabId) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<CommandPalette {...base} onNavigate={onNavigate} />);
    const input = screen.getByLabelText("Search project tools");
    expect(input).toHaveAttribute("dir", "auto");
    await user.type(input, query);
    await user.click(screen.getByText(label, { exact: true }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: "workspace-tab", tabId });
  });
  it("supports keyboard selection after normalized Arabic filtering", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...base} onNavigate={onNavigate} onClose={onClose} />);
    await user.type(
      screen.getByLabelText("Search project tools"),
      "\u0642\u064e\u0627\u0639\u0650\u062f\u064e\u0629 \u0627\u0644\u0628\u064e\u064a\u064e\u0627\u0646\u064e\u0627\u062a",
    );
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({
      kind: "workspace-tab",
      tabId: "database",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("keeps category and publishing restrictions on Arabic results", async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...base} />);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const input = screen.getByLabelText("Search project tools");
    await user.type(input, "\u0637\u0631\u0641\u064a\u0629");
    expect(screen.getByText("No matching tools in Connect.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Terminal", { exact: true })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "\u062a\u062d\u0644\u064a\u0644\u0627\u062a");
    expect(screen.queryByText("Analytics", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("No matching tools.")).toBeInTheDocument();
  });
});
