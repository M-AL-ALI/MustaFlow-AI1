import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PreviewActionsMenu,
  PreviewRoutesMenu,
  PreviewStatusSummary,
} from "./preview-toolbar-controls";

afterEach(cleanup);

const status = {
  hasRuntime: true,
  runtimeStatus: "running" as const,
  hasFiles: true,
  serverPreviewLive: true,
  webContainerLive: false,
  agenticPreviewUnavailable: false,
};

describe("Independent preview status", () => {
  it("shows runtime and source without duplicating the header build status", () => {
    render(<PreviewStatusSummary {...status} />);
    expect(screen.getByRole("status", { name: "Runtime and preview status" })).toBeVisible();
    expect(screen.getByText("Runtime running")).toBeVisible();
    expect(screen.getByText("Server preview")).toBeVisible();
    expect(screen.queryByText(/build failed|build in progress|published/i)).toBeNull();
  });

  it("keeps hibernation distinct from a working browser preview", () => {
    render(
      <PreviewStatusSummary
        {...status}
        runtimeStatus="hibernated"
        serverPreviewLive={false}
        webContainerLive
      />,
    );
    expect(screen.getByText("Runtime hibernated")).toBeVisible();
    expect(screen.getByText("Browser preview")).toBeVisible();
  });

  it("identifies a file preview without claiming a published snapshot", () => {
    render(<PreviewStatusSummary {...status} serverPreviewLive={false} />);
    expect(screen.getByText("File preview")).toBeVisible();
    expect(screen.queryByText(/published|frozen snapshot/i)).toBeNull();
  });

  it("does not turn missing runtime metadata into a running status", () => {
    render(<PreviewStatusSummary {...status} runtimeStatus={undefined} />);
    expect(screen.getByText("Runtime status unknown")).toBeVisible();
    expect(screen.queryByText("Runtime running")).toBeNull();
  });

  it("does not infer preview availability from a running runtime", () => {
    render(
      <PreviewStatusSummary {...status} serverPreviewLive={false} agenticPreviewUnavailable />,
    );
    expect(screen.getByText("Runtime running")).toBeVisible();
    expect(screen.getByText("Server preview unavailable")).toBeVisible();
    expect(screen.queryByText("Server preview")).toBeNull();
  });

  it("keeps a stopped runtime visible next to a file preview", () => {
    render(<PreviewStatusSummary {...status} runtimeStatus="stopped" serverPreviewLive={false} />);
    expect(screen.getByText("Runtime stopped")).toBeVisible();
    expect(screen.getByText("File preview")).toBeVisible();
  });
});

describe("Preview tools menu", () => {
  const actions = () => ({
    referenceActive: false,
    observing: false,
    focusMode: false,
    onAddReference: vi.fn(),
    onObserve: vi.fn(),
    onSelectRegion: vi.fn(),
    onRefreshRuntime: vi.fn(),
    onRestartBrowserPreview: vi.fn(),
    onToggleFocusMode: vi.fn(),
  });

  it.each([
    ["Ask Zero to observe this preview", "onObserve"],
    ["Point to a region for Zero", "onSelectRegion"],
    ["Add reference overlay", "onAddReference"],
    ["Refresh runtime status", "onRefreshRuntime"],
    ["Retry browser preview", "onRestartBrowserPreview"],
  ] as const)("keeps %s wired to its existing handler", async (label, callback) => {
    const user = userEvent.setup();
    const props = actions();
    render(<PreviewActionsMenu {...props} />);
    screen.getByRole("button", { name: "Preview tools" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: label }));
    expect(props[callback]).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("preserves the selected focus mode and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<PreviewActionsMenu {...props} focusMode />);
    const trigger = screen.getByRole("button", { name: "Preview tools" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Focus mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(props.onToggleFocusMode).not.toHaveBeenCalled();
  });

  it("invokes the focus toggle when its checkbox is selected", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<PreviewActionsMenu {...props} />);
    await user.click(screen.getByRole("button", { name: "Preview tools" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Focus mode" }));
    expect(props.onToggleFocusMode).toHaveBeenCalledTimes(1);
  });

  it("disables observation while sending without hiding unrelated recovery", async () => {
    const user = userEvent.setup();
    render(<PreviewActionsMenu {...actions()} observing />);
    await user.click(screen.getByRole("button", { name: "Preview tools" }));
    expect(
      screen.getByRole("menuitem", { name: "Ask Zero to observe this preview" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Point to a region for Zero" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Refresh runtime status" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("omits commands without a handler and keeps reference replacement available", async () => {
    const user = userEvent.setup();
    render(<PreviewActionsMenu referenceActive observing={false} onAddReference={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Preview tools" }));
    expect(screen.getByRole("menuitem", { name: "Replace reference overlay" })).toBeVisible();
    expect(screen.queryByText("Recovery")).toBeNull();
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Ask Zero/ })).toBeNull();
  });
});

describe("Preview routes menu", () => {
  const routes = [
    { path: "/", label: "/", kind: "web" as const },
    { path: "/about.html", label: "/about.html", kind: "web" as const },
    { path: "/account", label: "/account", kind: "expo" as const, fileId: 73 },
  ];

  function Routes({
    onNavigate,
    onOpenFile,
  }: {
    onNavigate: (path: string) => void;
    onOpenFile?: (id: number) => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <PreviewRoutesMenu
        routes={routes}
        currentPath="/"
        open={open}
        onOpenChange={setOpen}
        onNavigate={onNavigate}
        onOpenFile={onOpenFile}
      />
    );
  }

  it("groups page navigation separately from source-file actions", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onOpenFile = vi.fn();
    render(<Routes onNavigate={onNavigate} onOpenFile={onOpenFile} />);
    const trigger = screen.getByRole("button", { name: "Browse preview routes" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Preview pages")).toBeVisible();
    expect(screen.getByText("Native source files")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Navigate to /" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(screen.getByRole("menuitem", { name: "Navigate to /about.html" }));
    expect(onNavigate).toHaveBeenCalledWith("/about.html");
    expect(onOpenFile).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Open source file for /account" }));
    expect(onOpenFile).toHaveBeenCalledWith(73);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("disables source entries when no editor handler is available", async () => {
    const user = userEvent.setup();
    render(<Routes onNavigate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Browse preview routes" }));
    expect(screen.getByRole("menuitem", { name: "Open source file for /account" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
