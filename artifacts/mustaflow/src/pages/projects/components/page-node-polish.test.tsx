import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageNode, type PageNodeData } from "./page-node";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}));

afterEach(cleanup);

function nodeProps(overrides: Partial<PageNodeData> = {}) {
  return {
    id: "account",
    type: "pageNode",
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    data: {
      label: "Account",
      pageType: "settings" as const,
      filePath: "src/pages/Account.tsx",
      notes: "Route: /account/profile",
      projectId: 901,
      previewEnabled: true,
      isNew: false,
      hasError: false,
      aiGenerated: true,
      onNodeClick: vi.fn(),
      onPreviewClick: vi.fn(),
      ...overrides,
    },
  };
}

describe("Page Map card accessibility and evidence", () => {
  it.each([false, undefined])(
    "does not load a frame without positive readiness (%s)",
    (previewEnabled) => {
      const props = nodeProps({ previewEnabled });
      render(<PageNode {...props} />);
      expect(screen.queryByTitle("Preview of Account")).toBeNull();
      expect(screen.getByText("Open Preview to view this page")).toBeVisible();
      fireEvent.keyDown(screen.getByRole("button", { name: "Open preview: Account" }), {
        key: "Enter",
      });
      expect(props.data.onPreviewClick).toHaveBeenCalledExactlyOnceWith(
        "src/pages/Account.tsx",
        "/account/profile",
      );
      expect(props.data.onNodeClick).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("opens details from the keyboard (planned: %s)", async (planned) => {
    const user = userEvent.setup();
    const props = nodeProps({ planned });
    render(<PageNode {...props} />);
    await user.tab();
    expect(screen.getByRole("button", { name: "View details for Account" })).toHaveFocus();
    await user.keyboard("{Enter} ");
    expect(props.data.onNodeClick).toHaveBeenCalledTimes(2);
    expect(props.data.onNodeClick).toHaveBeenLastCalledWith("account");
    expect(props.data.onPreviewClick).not.toHaveBeenCalled();
  });

  it("keeps preview activation separate from details and preserves iframe restrictions", () => {
    const props = nodeProps();
    render(<PageNode {...props} />);
    const frame = screen.getByTitle("Preview of Account");
    expect(frame).toHaveAttribute("src", "/api/projects/901/preview/account/profile");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(screen.getByRole("button", { name: "Open preview: Account" }), { key: " " });
    expect(props.data.onPreviewClick).toHaveBeenCalledWith(
      "src/pages/Account.tsx",
      "/account/profile",
    );
    expect(props.data.onNodeClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "View details for Account" })).not.toContainElement(
      frame,
    );
  });

  it.each(["//outside.test", "/:account", "/%2e%2e/private", "/%252f%252foutside.test"])(
    "does not preview unsafe or unresolved route %s",
    (route) => {
      const props = nodeProps({ notes: `Route: ${route}` });
      render(<PageNode {...props} />);
      expect(screen.queryByTitle("Preview of Account")).toBeNull();
      fireEvent.keyDown(screen.getByRole("button", { name: "View page details: Account" }), {
        key: "Enter",
      });
      expect(props.data.onPreviewClick).not.toHaveBeenCalled();
      expect(props.data.onNodeClick).toHaveBeenCalledWith("account");
    },
  );

  it("treats absent mapped edges as coverage information", () => {
    render(<PageNode {...nodeProps({ isOrphan: true, isDeadEnd: true })} />);
    expect(screen.getByText("No connections mapped yet")).toBeVisible();
    expect(screen.getByText("Runtime navigation not verified")).toBeVisible();
    expect(screen.queryByText(/wiring issue|goes nowhere|build error|not linked/i)).toBeNull();
  });

  it("does not imply a planned page already has a preview", () => {
    render(<PageNode {...nodeProps({ planned: true })} />);
    expect(screen.queryByTitle("Preview of Account")).toBeNull();
    expect(screen.getByText("Planned page")).toBeVisible();
    expect(screen.queryByText(/no file yet/i)).toBeNull();
  });
});
