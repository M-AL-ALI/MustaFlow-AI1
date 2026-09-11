import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceSwitcher } from "../workspace-switcher";

const state = vi.hoisted(() => ({
  select: vi.fn(),
  navigate: vi.fn(),
  create: vi.fn(),
  retry: vi.fn(),
  isError: false,
}));
vi.mock("wouter", () => ({ useLocation: () => ["/projects", state.navigate] }));
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: 1, name: "Product studio" },
    workspaces: [
      { id: 1, name: "Product studio" },
      { id: 2, name: "Client work" },
    ],
    setCurrentWorkspaceId: state.select,
    isLoading: false,
    isError: state.isError,
    retryWorkspaces: state.retry,
    createWorkspace: state.create,
    isCreating: false,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.isError = false;
  state.create.mockReset();
});
afterEach(cleanup);

async function openSwitcher() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Switch workspace, Product studio" }), {
    key: "Enter",
  });
  return screen.findByRole("menu");
}

describe("Workspace navigation completion callback", () => {
  it("notifies navigation after selecting a workspace even on the existing projects route", async () => {
    const onNavigate = vi.fn();
    render(<WorkspaceSwitcher onNavigate={onNavigate} />);
    await openSwitcher();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Client work" }));
    expect(state.select).toHaveBeenCalledWith(2);
    expect(state.navigate).toHaveBeenCalledWith("/projects");
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("notifies only after successful workspace creation", async () => {
    state.create.mockResolvedValue({ id: 3, name: "Navigation lab" });
    const onNavigate = vi.fn();
    render(<WorkspaceSwitcher onNavigate={onNavigate} />);
    await openSwitcher();
    fireEvent.click(screen.getByRole("menuitem", { name: "Create workspace" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Navigation lab" },
    });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledOnce());
    expect(state.navigate).toHaveBeenCalledWith("/projects");
  });
  it("does not close navigation or leave the form when creation fails", async () => {
    state.create.mockRejectedValue(new Error("provider failed"));
    const onNavigate = vi.fn();
    render(<WorkspaceSwitcher onNavigate={onNavigate} />);
    await openSwitcher();
    fireEvent.click(screen.getByRole("menuitem", { name: "Create workspace" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Navigation lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("does not navigate when a workspace list error is retried", async () => {
    state.isError = true;
    const onNavigate = vi.fn();
    render(<WorkspaceSwitcher onNavigate={onNavigate} />);
    await openSwitcher();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry workspace loading" }));
    expect(state.retry).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("does not treat cancellation as a completed navigation", async () => {
    const onNavigate = vi.fn();
    render(<WorkspaceSwitcher onNavigate={onNavigate} />);
    await openSwitcher();
    fireEvent.click(screen.getByRole("menuitem", { name: "Create workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
});
