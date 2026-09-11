import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceToolOpen } from "@workspace/nabuflow-workspace-tools";
import { EditorToolStrip } from "./editor-tool-strip";

const props = {
  projectId: 101,
  activeTab: "preview",
  isPublished: false,
  isMobile: false,
  chatOpen: false,
  pageMapSyncing: false,
  onNavigate: vi.fn(),
  onOpenTools: vi.fn(),
  onToggleChat: vi.fn(),
};
describe("project tool strip", () => {
  it("retains secondary tools as the selected destination changes", () => {
    const { rerender } = render(<EditorToolStrip {...props} activeTab="database" />);
    rerender(<EditorToolStrip {...props} activeTab="terminal" />);
    expect(screen.getByRole("button", { name: "Database" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: "Close Preview tab" })).not.toBeInTheDocument();
  });
  it("closes an inactive view without navigating or performing a resource action", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { rerender } = render(
      <EditorToolStrip {...props} onNavigate={onNavigate} activeTab="database" />,
    );
    rerender(<EditorToolStrip {...props} onNavigate={onNavigate} activeTab="terminal" />);
    await user.click(screen.getByRole("button", { name: "Close Database tab" }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Database" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  it("returns to Preview when closing the selected secondary view", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [target, setTarget] = useState<WorkspaceToolOpen>({
        kind: "workspace-tab",
        tabId: "database",
      });
      return <EditorToolStrip {...props} activeTab={target.tabId} onNavigate={setTarget} />;
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Close Database tab" }));
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Database" })).not.toBeInTheDocument();
  });
  it("does not carry open tools into another project or resurrect them on return", () => {
    const { rerender } = render(<EditorToolStrip {...props} activeTab="database" />);
    rerender(<EditorToolStrip {...props} projectId={102} />);
    expect(screen.queryByRole("button", { name: "Database" })).not.toBeInTheDocument();
    rerender(<EditorToolStrip {...props} />);
    expect(screen.queryByRole("button", { name: "Database" })).not.toBeInTheDocument();
  });
  it("preserves the Workflows subview without duplicate setup tabs", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { rerender } = render(
      <EditorToolStrip
        {...props}
        onNavigate={onNavigate}
        activeTab="tools-files"
        subview="files"
      />,
    );
    rerender(
      <EditorToolStrip
        {...props}
        onNavigate={onNavigate}
        activeTab="tools-files"
        subview="shell"
      />,
    );
    rerender(
      <EditorToolStrip {...props} onNavigate={onNavigate} activeTab="preview" subview="shell" />,
    );
    expect(screen.queryByRole("button", { name: "Project setup" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "workspace-tab",
      tabId: "tools-files",
      subview: "shell",
    });
  });
  it("removes Analytics when published availability is lost", () => {
    const { rerender } = render(<EditorToolStrip {...props} activeTab="analytics" isPublished />);
    rerender(<EditorToolStrip {...props} activeTab="analytics" />);
    expect(screen.queryByRole("button", { name: "Analytics" })).not.toBeInTheDocument();
  });
  it("keeps mobile navigation to five controls and opens the same tool catalog", async () => {
    const user = userEvent.setup();
    const onOpenTools = vi.fn();
    const onToggleChat = vi.fn();
    render(
      <EditorToolStrip
        {...props}
        isMobile
        activeTab="database"
        onOpenTools={onOpenTools}
        onToggleChat={onToggleChat}
      />,
    );
    expect(screen.getByTestId("workspace-mobile-tabs").querySelectorAll("button")).toHaveLength(5);
    expect(screen.queryByTestId("workspace-core-tabs")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open project tools" }));
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(onOpenTools).toHaveBeenCalledTimes(1);
    expect(onToggleChat).toHaveBeenCalledTimes(1);
  });
  it("does not mark a page current while the mobile chat is open", () => {
    render(<EditorToolStrip {...props} isMobile chatOpen />);
    expect(document.querySelector('[aria-current="page"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
  });
  it("retains open tools across responsive layout changes", () => {
    const { rerender } = render(<EditorToolStrip {...props} activeTab="database" />);
    rerender(<EditorToolStrip {...props} isMobile activeTab="terminal" />);
    rerender(<EditorToolStrip {...props} activeTab="terminal" />);
    expect(screen.getByRole("button", { name: "Database" })).toBeInTheDocument();
  });
  it("exposes page-map synchronization without requiring color perception", () => {
    render(<EditorToolStrip {...props} activeTab="page-map" pageMapSyncing />);
    expect(screen.getByRole("status", { name: "Page map updating" })).toBeInTheDocument();
  });
});
