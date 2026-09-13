import { useState, type AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  select: vi.fn(),
  create: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/projects", state.navigate],
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-admin-access", () => ({ useAdminAccess: () => ({ isAdmin: false }) }));
vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({ isLoaded: true, isSignedIn: true, user: null }),
  useClerkActions: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: 17, name: "Studio" },
    workspaces: [
      { id: 17, name: "Studio" },
      { id: 18, name: "Client" },
    ],
    setCurrentWorkspaceId: state.select,
    createWorkspace: state.create,
    isLoading: false,
    isError: false,
    isCreating: false,
    retryWorkspaces: vi.fn(),
  }),
}));

import { WorkspaceNavigation } from "../slide-out-nav";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

// Exercise the actual Sheet, dropdown, switcher and creation dialog together.
// Mock only application data and routing, not their focus/pointer lifetimes.
function Navigation({ desktop = false }: { desktop?: boolean }) {
  const [clicks, setClicks] = useState(0);
  return (
    <>
      <WorkspaceNavigation
        layout={{ isDesktop: desktop, expanded: desktop, onToggle: () => {} }}
        location="/projects"
        isAdmin={false}
        account={null}
        renderWorkspace={(onNavigate) => <WorkspaceSwitcher onNavigate={onNavigate} />}
      />
      <button type="button" onClick={() => setClicks((count) => count + 1)}>
        Workspace action {clicks}
      </button>
    </>
  );
}

async function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "Open NabuFlow navigation" }));
  return screen.findByRole("dialog", { name: "NabuFlow" });
}

async function openSwitcher() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Switch workspace, Studio" }), {
    key: "ArrowDown",
    code: "ArrowDown",
  });
  return screen.findByRole("menu");
}

async function expectPageReleased() {
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  expect(getComputedStyle(document.body).pointerEvents).not.toBe("none");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.create.mockResolvedValue({ id: 19, name: "New studio" });
  expect(document.body.style.pointerEvents).not.toBe("none");
});
afterEach(cleanup);

describe("Workspace menu and navigation modal composition", () => {
  it("releases the page after same-route workspace selection and lets navigation reopen", async () => {
    render(<Navigation />);
    await openDrawer();
    expect(document.body.style.pointerEvents).toBe("none");
    const menu = await openSwitcher();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Client" }));
    expect(state.select).toHaveBeenCalledExactlyOnceWith(18);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/projects");
    await expectPageReleased();
    fireEvent.click(screen.getByRole("button", { name: "Workspace action 0" }));
    expect(screen.getByRole("button", { name: "Workspace action 1" })).toBeInTheDocument();
    const reopened = await openDrawer();
    fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
    await expectPageReleased();
  });

  it("dismisses the menu with Escape before dismissing the drawer and restores trigger focus", async () => {
    render(<Navigation />);
    const trigger = screen.getByRole("button", { name: "Open NabuFlow navigation" });
    await openDrawer();
    const menu = await openSwitcher();
    fireEvent.keyDown(menu, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const drawer = screen.getByRole("dialog", { name: "NabuFlow" });
    expect(document.body.style.pointerEvents).toBe("none");
    fireEvent.keyDown(drawer, { key: "Escape", code: "Escape" });
    await expectPageReleased();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(state.select).not.toHaveBeenCalled();
  });

  it("keeps the drawer usable after canceling workspace creation", async () => {
    render(<Navigation />);
    await openDrawer();
    const menu = await openSwitcher();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Create workspace" }));
    const creation = await screen.findByRole("dialog", { name: "Create workspace" });
    fireEvent.change(within(creation).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Unsubmitted idea" },
    });
    fireEvent.click(within(creation).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Create workspace" })).toBeNull(),
    );
    const drawer = screen.getByRole("dialog", { name: "NabuFlow" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    await expectPageReleased();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("releases both dialogs after confirmed workspace creation", async () => {
    render(<Navigation />);
    await openDrawer();
    const menu = await openSwitcher();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Create workspace" }));
    const creation = await screen.findByRole("dialog", { name: "Create workspace" });
    fireEvent.change(within(creation).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "New studio" },
    });
    fireEvent.click(within(creation).getByRole("button", { name: "Create workspace" }));
    await expectPageReleased();
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      name: "New studio",
      description: undefined,
      type: "personal",
    });
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/projects");
  });

  it("keeps desktop selection nonmodal and navigates once", async () => {
    render(<Navigation desktop />);
    const menu = await openSwitcher();
    expect(document.body.style.pointerEvents).not.toBe("none");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Client" }));
    await expectPageReleased();
    expect(state.select).toHaveBeenCalledExactlyOnceWith(18);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/projects");
    expect(screen.getByRole("complementary", { name: "NabuFlow sidebar" })).toBeInTheDocument();
  });

  it("releases the mobile layers if the viewport changes while the menu is open", async () => {
    const page = render(<Navigation />);
    await openDrawer();
    await openSwitcher();
    page.rerender(<Navigation desktop />);
    await expectPageReleased();
    expect(screen.getByRole("complementary", { name: "NabuFlow sidebar" })).toBeInTheDocument();
    expect(state.select).not.toHaveBeenCalled();
  });
});
