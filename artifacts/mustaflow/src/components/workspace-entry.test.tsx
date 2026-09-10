import {
  Children,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceEntry,
  type WorkspaceEntryItem,
  type WorkspaceEntryProps,
} from "./workspace-entry";

const personal: WorkspaceEntryItem = {
  id: 7,
  name: "My Workspace",
  description: "Personal projects",
  type: "personal",
};

const client: WorkspaceEntryItem = {
  id: 9,
  name: "Legacy tests",
  description: null,
  type: "client",
};

function props(overrides: Partial<WorkspaceEntryProps> = {}) {
  return {
    workspaces: [personal, client],
    state: "ready" as const,
    currentWorkspaceId: personal.id,
    onChooseWorkspace: vi.fn(),
    onCreateWorkspace: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

type ButtonElement = ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;

// This view has no hooks or effects. Exercise its callback contract without a
// browser, router, authentication provider, API client or project mutation.
function buttons(node: ReactNode): ButtonElement[] {
  const found: ButtonElement[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === "button") found.push(child as ButtonElement);
    found.push(...buttons(child.props.children));
  });
  return found;
}

function label(button: ButtonElement): string {
  return button.props["aria-label"] ?? renderToStaticMarkup(button).replace(/<[^>]*>/gu, "");
}

function click(button: ButtonElement | undefined): void {
  if (!button || button.props.disabled) return;
  const handler = button.props.onClick as (() => void) | undefined;
  handler?.();
}

describe("explicit workspace entry", () => {
  it("requires an explicit choice even when only one workspace exists", () => {
    const value = props({ workspaces: [personal] });
    const tree = WorkspaceEntry(value);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Choose a workspace");
    expect(html).toContain('aria-label="Open workspace My Workspace"');
    expect(value.onChooseWorkspace).not.toHaveBeenCalled();
    expect(value.onCreateWorkspace).not.toHaveBeenCalled();

    click(buttons(tree).find((button) => label(button) === "Open workspace My Workspace"));
    expect(value.onChooseWorkspace).toHaveBeenCalledOnce();
    expect(value.onChooseWorkspace).toHaveBeenCalledWith(7);
    expect(value.onCreateWorkspace).not.toHaveBeenCalled();
  });

  it("opens only the workspace explicitly chosen from multiple choices", () => {
    const value = props();
    const tree = WorkspaceEntry(value);
    expect(value.onChooseWorkspace).not.toHaveBeenCalled();
    click(buttons(tree).find((button) => label(button) === "Open workspace Legacy tests"));
    expect(value.onChooseWorkspace).toHaveBeenCalledOnce();
    expect(value.onChooseWorkspace).toHaveBeenCalledWith(9);
    expect(value.onCreateWorkspace).not.toHaveBeenCalled();
    expect(value.onRetry).not.toHaveBeenCalled();
  });

  it("treats a remembered selection as a hint, not automatic entry", () => {
    const value = props({ currentWorkspaceId: client.id });
    const tree = WorkspaceEntry(value);
    const choices = buttons(tree);
    const current = choices.find((button) => label(button) === "Open workspace Legacy tests");
    const other = choices.find((button) => label(button) === "Open workspace My Workspace");
    expect(renderToStaticMarkup(current!)).toContain("Selected");
    expect(renderToStaticMarkup(other!)).not.toContain("Selected");
    expect(value.onChooseWorkspace).not.toHaveBeenCalled();
    click(other);
    expect(value.onChooseWorkspace).toHaveBeenCalledWith(personal.id);
  });

  it("offers workspace creation independently of opening an existing workspace", () => {
    const value = props();
    click(buttons(WorkspaceEntry(value)).find((button) => label(button) === "Create workspace"));
    expect(value.onCreateWorkspace).toHaveBeenCalledOnce();
    expect(value.onChooseWorkspace).not.toHaveBeenCalled();
    expect(value.onRetry).not.toHaveBeenCalled();
  });

  it("offers the same separate creation action for an empty account", () => {
    const value = props({ workspaces: [], currentWorkspaceId: null });
    const tree = WorkspaceEntry(value);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Create your first workspace");
    expect(html).not.toContain('aria-label="Open workspace');
    click(buttons(tree).find((button) => label(button) === "Create workspace"));
    expect(value.onCreateWorkspace).toHaveBeenCalledOnce();
    expect(value.onChooseWorkspace).not.toHaveBeenCalled();
  });

  it.each(["loading", "error"] as const)(
    "does not expose cached workspace choices or creation while %s",
    (state) => {
      const value = props({ state });
      const tree = WorkspaceEntry(value);
      const html = renderToStaticMarkup(tree);
      expect(html).not.toContain("My Workspace");
      expect(html).not.toContain("Legacy tests");
      expect(html).not.toContain('aria-label="Open workspace');
      const create = buttons(tree).find((button) => label(button) === "Create workspace");
      expect(create?.props.disabled).toBe(true);
      expect(create?.props.onClick).toBeUndefined();
      click(create);
      expect(value.onChooseWorkspace).not.toHaveBeenCalled();
      expect(value.onCreateWorkspace).not.toHaveBeenCalled();
    },
  );

  it("has an accessible loading state instead of an empty-workspace prompt", () => {
    const value = props({ state: "loading", workspaces: [] });
    const html = renderToStaticMarkup(WorkspaceEntry(value));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading your workspaces...");
    expect(html).not.toContain("Create your first workspace");
  });

  it("retries a failed list without choosing or creating a workspace", () => {
    const value = props({ state: "error" });
    const tree = WorkspaceEntry(value);
    expect(renderToStaticMarkup(tree)).toContain('role="alert"');
    click(buttons(tree).find((button) => label(button) === "Retry workspaces"));
    expect(value.onRetry).toHaveBeenCalledOnce();
    expect(value.onChooseWorkspace).not.toHaveBeenCalled();
    expect(value.onCreateWorkspace).not.toHaveBeenCalled();
  });

  it("disables repeated retry callbacks while a retry is pending", () => {
    const value = props({ state: "error", retrying: true });
    const tree = WorkspaceEntry(value);
    const retry = buttons(tree).find((button) => label(button) === "Retrying workspaces...");
    expect(retry?.props.disabled).toBe(true);
    expect(retry?.props.onClick).toBeUndefined();
    click(retry);
    expect(value.onRetry).not.toHaveBeenCalled();
  });

  it("uses explicit buttons and does not expose project-creation or Library navigation", () => {
    const tree = WorkspaceEntry(props());
    const html = renderToStaticMarkup(tree);
    expect(buttons(tree).every((button) => button.props.type === "button")).toBe(true);
    expect(html).not.toContain("/projects/new");
    expect(html).not.toContain("/library");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<a ");
  });
});
