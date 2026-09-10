import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateWorkspaceModal } from "../create-workspace-modal";
import { WorkspaceSwitcher } from "../workspace-switcher";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  select: vi.fn(),
  retry: vi.fn(),
  isError: false,
  isLoading: false,
}));
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspace: () => ({
    createWorkspace: state.create,
    isCreating: false,
    currentWorkspace: { id: 1, name: "Product studio" },
    workspaces: [
      { id: 1, name: "Product studio" },
      { id: 2, name: "Client work" },
    ],
    setCurrentWorkspaceId: state.select,
    isError: state.isError,
    isLoading: state.isLoading,
    retryWorkspaces: state.retry,
  }),
}));
beforeEach(() => {
  state.create.mockReset();
  state.select.mockReset();
  state.retry.mockReset();
  state.isError = false;
  state.isLoading = false;
});
afterEach(cleanup);

describe("Workspace creation confirmation", () => {
  it("retains the form after a failure without printing provider error details", async () => {
    state.create.mockRejectedValue(new Error("internal credential=secret"));
    const close = vi.fn();
    render(<CreateWorkspaceModal open onOpenChange={close} />);
    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Design lab" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Your details are unchanged"),
    );
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe("Design lab");
    expect(screen.queryByText(/credential=secret/)).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("waits for server confirmation, prevents duplicate submits and pending dismissal, then closes", async () => {
    let resolve!: (value: unknown) => void;
    state.create.mockImplementation(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    const close = vi.fn();
    render(<CreateWorkspaceModal open onOpenChange={close} />);
    const input = screen.getByLabelText("Workspace name");
    fireEvent.change(input, { target: { value: "  Design lab  " } });
    const form = input.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledWith({
      name: "Design lab",
      description: undefined,
      type: "personal",
    });
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    await act(async () => resolve({ id: 4 }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });

  it("does not create empty names or submit while composing non-Latin text", () => {
    render(<CreateWorkspaceModal open onOpenChange={vi.fn()} />);
    const input = screen.getByLabelText("Workspace name");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(state.create).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Design lab" } });
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, event);
    expect(event.defaultPrevented).toBe(true);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("keeps optional categories distinct from permission or invitation promises", () => {
    render(<CreateWorkspaceModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Optional details"));
    expect(screen.getByText(/does not invite people or change their permissions/)).toBeTruthy();
    expect(screen.queryByText("Collaborate with others")).toBeNull();
  });
});

describe("Workspace switcher keyboard and honest states", () => {
  it("opens with the keyboard, marks the current workspace and restores focus on Escape", async () => {
    render(<WorkspaceSwitcher />);
    const trigger = screen.getByRole("button", { name: "Switch workspace, Product studio" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("menuitemradio", { name: "Product studio" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("selects an explicit destination without creating another workspace", async () => {
    render(<WorkspaceSwitcher />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Switch workspace, Product studio" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Client work" }));
    expect(state.select).toHaveBeenCalledWith(2);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("offers a retry rather than pretending a failed list is empty", async () => {
    state.isError = true;
    render(<WorkspaceSwitcher />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Switch workspace, Product studio" }), {
      key: "Enter",
    });
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining("last known"),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry workspace loading" }));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });
});
