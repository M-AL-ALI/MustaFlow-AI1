import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTrashDialog, type TrashProject } from "../project-trash-dialog";

const project = { id: 58, name: "Disposable acceptance project" };

function Harness({
  onConfirm,
  target = project,
}: {
  onConfirm: (target: TrashProject) => Promise<void>;
  target?: TrashProject;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open Trash confirmation</button>
      {open && (
        <ProjectTrashDialog project={target} onConfirm={onConfirm} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

describe("recoverable project Trash confirmation", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("Native browser confirmations must not be used");
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the selected project and retention window without submitting", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open Trash confirmation" }));

    expect(screen.getByRole("alertdialog", { name: "Move project to Trash?" })).toBeTruthy();
    expect(screen.getByText(project.name)).toBeTruthy();
    expect(screen.getByText(/restore it from Trash for 30 days/)).toBeTruthy();
    expect(screen.getByText(/permanently deleted automatically/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("cancels without a mutation and returns keyboard focus", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Open Trash confirmation" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("lets Escape cancel before a request starts", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open Trash confirmation" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("submits only the confirmed identity and blocks duplicate clicks and dismissal while pending", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open Trash confirmation" }));
    const confirm = screen.getByRole("button", { name: "Move to Trash" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(project);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("status").textContent).toContain("Please wait");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the same project visible on failure and allows an explicit retry", async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cleanup could not start. Try again."))
      .mockResolvedValueOnce(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open Trash confirmation" }));
    await user.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Cleanup could not start");
    expect(screen.getByText(project.name)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenNthCalledWith(2, project);
  });

  it("renders project names as text rather than executable markup", async () => {
    const user = userEvent.setup();
    const target = { id: 58, name: '<img src=x onerror="alert(1)">' };
    render(<Harness onConfirm={vi.fn().mockResolvedValue(undefined)} target={target} />);
    await user.click(screen.getByRole("button", { name: "Open Trash confirmation" }));
    expect(screen.getByText(target.name)).toBeTruthy();
    expect(screen.getByRole("alertdialog").querySelector("img")).toBeNull();
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
