import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
vi.mock("@/hooks/use-admin-access", () => ({
  useAdminAccess: () => ({ isAdmin: false, role: null }),
}));
vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div>Test workspace</div>,
}));
vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: { fullName: "Test User", emailAddresses: [] },
  }),
  useClerkActions: () => ({ signOut: vi.fn() }),
}));
import { SlideOutNav } from "../slide-out-nav";
afterEach(cleanup);

describe("Redesigned workspace navigation", () => {
  it("does not leave a closed drawer's links available to keyboard or assistive technology", () => {
    render(<SlideOutNav />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("link", { name: "Billing & Usage" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Admin Page" })).toBeNull();
  });
  it("opens a named modal, exposes regular-user Trash, and returns focus on close", async () => {
    render(<SlideOutNav />);
    const trigger = screen.getByRole("button", { name: "Open NabuFlow navigation" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "NabuFlow" });
    expect(within(dialog).getByRole("link", { name: "Trash" }).getAttribute("href")).toBe("/trash");
    expect(within(dialog).getByRole("link", { name: "New project" }).getAttribute("href")).toBe(
      "/projects/new",
    );
    expect(within(dialog).queryByRole("link", { name: "Admin Page" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
