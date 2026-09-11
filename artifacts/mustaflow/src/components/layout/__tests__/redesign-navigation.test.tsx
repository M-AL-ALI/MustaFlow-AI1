import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const state = vi.hoisted(() => ({ isAdmin: false, signedIn: true, userId: "owner-a" }));
vi.mock("../public-header", () => ({
  PublicHeader: () => <header>Unchanged public header</header>,
}));
vi.mock("@/hooks/use-admin-access", () => ({
  useAdminAccess: () => ({ isAdmin: state.isAdmin, role: state.isAdmin ? "admin" : null }),
}));
vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: ({ onNavigate }: { onNavigate?: () => void }) => (
    <button type="button" onClick={onNavigate}>
      Test workspace
    </button>
  ),
}));
vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: true,
    isSignedIn: state.signedIn,
    user: { id: state.userId, fullName: "Test User", emailAddresses: [] },
  }),
  useClerkActions: () => ({ signOut: vi.fn() }),
}));
import { SlideOutNav } from "../slide-out-nav";

import { WorkspaceShell } from "../workspace-shell";
import { AppLayout } from "../app-layout";
import { WorkspaceNavigation } from "../slide-out-nav";

let desktop = false;
let listeners: Set<() => void>;

beforeEach(() => {
  state.isAdmin = false;
  state.signedIn = true;
  state.userId = "owner-a";
  desktop = false;
  listeners = new Set();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return desktop;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function resize(isDesktop: boolean) {
  act(() => {
    desktop = isDesktop;
    listeners.forEach((listener) => listener());
  });
}

function Shell({ location = "/projects" }: { location?: string }) {
  return (
    <WorkspaceShell
      location={location}
      renderNavigation={(layout) => <SlideOutNav layout={layout} />}
    >
      <h1>Workspace content</h1>
      <input aria-label="Uninterrupted project draft" defaultValue="Keep my idea" />
    </WorkspaceShell>
  );
}

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

describe("Responsive workspace shell", () => {
  it.each(["/projects", "/projects/new", "/trash", "/integrations", "/published"])(
    "opens a labeled desktop sidebar on %s without a modal",
    (location) => {
      desktop = true;
      render(<Shell location={location} />);
      expect(screen.getByRole("button", { name: "Collapse workspace navigation" })).toHaveProperty(
        "ariaExpanded",
        "true",
      );
      expect(screen.getByRole("button", { name: "Test workspace" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "New project" }).getAttribute("href")).toBe(
        "/projects/new",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("navigation", { name: "Quick navigation" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open NabuFlow navigation" })).toBeNull();
    },
  );

  it.each(["/projects/61", "/projects/61/files"])(
    "keeps the project editor compact by default on %s",
    (location) => {
      desktop = true;
      render(<Shell location={location} />);
      expect(screen.getByRole("button", { name: "Expand workspace navigation" })).toHaveProperty(
        "ariaExpanded",
        "false",
      );
      expect(screen.queryByRole("button", { name: "Test workspace" })).toBeNull();
      expect(screen.getByRole("link", { name: "Billing & Usage" }).getAttribute("title")).toBe(
        "Billing & Usage",
      );
      expect(screen.getByRole("link", { name: "Trash" }).getAttribute("href")).toBe("/trash");
    },
  );

  it("collapses and expands without unmounting the project or losing toggle focus", () => {
    desktop = true;
    render(<Shell />);
    const draft = screen.getByRole("textbox", { name: "Uninterrupted project draft" });
    fireEvent.change(draft, { target: { value: "My unsent draft" } });
    const toggle = screen.getByRole("button", { name: "Collapse workspace navigation" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Expand workspace navigation" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Collapse workspace navigation" })).toBe(toggle);
    expect(screen.getByRole("textbox", { name: "Uninterrupted project draft" })).toBe(draft);
    expect(draft).toHaveProperty("value", "My unsent draft");
    expect(document.activeElement).toBe(toggle);
  });

  it("preserves an explicit choice only while the shell remains mounted", () => {
    desktop = true;
    const view = render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace navigation" }));
    view.rerender(<Shell location="/settings" />);
    expect(screen.getByRole("button", { name: "Expand workspace navigation" })).toBeTruthy();
    resize(false);
    resize(true);
    expect(screen.getByRole("button", { name: "Expand workspace navigation" })).toBeTruthy();
    view.unmount();
    render(<Shell />);
    expect(screen.getByRole("button", { name: "Collapse workspace navigation" })).toBeTruthy();
  });

  it("closes a drawer when its workspace selection keeps the same URL", async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Open NabuFlow navigation" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Test workspace" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not resurrect an open drawer when resizing through desktop", async () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Open NabuFlow navigation" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    resize(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Collapse workspace navigation" })).toBeTruthy();
    resize(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Open NabuFlow navigation" })).toBeTruthy();
  });

  it("does not move keyboard focus away from the main draft during a resize", () => {
    render(<Shell />);
    const draft = screen.getByRole("textbox");
    draft.focus();
    resize(true);
    expect(document.activeElement).toBe(draft);
    resize(false);
    expect(document.activeElement).toBe(draft);
  });

  it("keeps staff navigation absent until the existing access hook grants it, and removes it on revocation", () => {
    desktop = true;
    const view = render(<Shell />);
    expect(screen.queryByRole("link", { name: "Admin Page" })).toBeNull();
    state.isAdmin = true;
    view.rerender(<Shell />);
    expect(screen.getByRole("link", { name: "Admin Page" }).getAttribute("href")).toBe("/admin");
    state.isAdmin = false;
    view.rerender(<Shell />);
    expect(screen.queryByRole("link", { name: "Admin Page" })).toBeNull();
  });

  it("marks only route boundaries active, not similarly named destinations", () => {
    desktop = true;
    const view = render(
      <WorkspaceNavigation
        location="/trash/archive"
        isAdmin={false}
        renderWorkspace={() => null}
        account={null}
        layout={{ isDesktop: true, expanded: true, onToggle: vi.fn() }}
      />,
    );
    expect(screen.getByRole("link", { name: "Trash" }).getAttribute("aria-current")).toBe("page");
    view.rerender(
      <WorkspaceNavigation
        location="/trashcan"
        isAdmin={false}
        renderWorkspace={() => null}
        account={null}
        layout={{ isDesktop: true, expanded: true, onToggle: vi.fn() }}
      />,
    );
    expect(screen.getByRole("link", { name: "Trash" }).hasAttribute("aria-current")).toBe(false);
  });

  it("unsubscribes from breakpoint changes on unmount", () => {
    const view = render(<Shell />);
    expect(listeners.size).toBe(1);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it("retains the existing drawer fallback without matchMedia support", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Shell />);
    expect(screen.getByRole("button", { name: "Open NabuFlow navigation" })).toBeTruthy();
  });

  it("supports older media-query listeners and removes them", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addListener, removeListener }));
    const view = render(<Shell />);
    expect(addListener).toHaveBeenCalledOnce();
    view.unmount();
    expect(removeListener).toHaveBeenCalledWith(addListener.mock.calls[0][0]);
  });

  it("leaves the signed-out layout unchanged", () => {
    state.signedIn = false;
    desktop = true;
    render(
      <AppLayout>
        <p>Public content</p>
      </AppLayout>,
    );
    expect(screen.getByText("Unchanged public header")).toBeTruthy();
    expect(screen.getByText("Public content")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "NabuFlow sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: /workspace navigation/ })).toBeNull();
  });

  it("resets the mounted shell preference when the signed-in account changes", () => {
    desktop = true;
    const view = render(
      <AppLayout>
        <p>Workspace content</p>
      </AppLayout>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace navigation" }));
    state.userId = "owner-b";
    view.rerender(
      <AppLayout>
        <p>Workspace content</p>
      </AppLayout>,
    );
    expect(screen.getByRole("button", { name: "Collapse workspace navigation" })).toBeTruthy();
  });
});
