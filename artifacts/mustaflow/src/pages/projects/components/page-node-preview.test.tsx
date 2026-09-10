import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PageNode } from "./page-node";
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}));
afterEach(cleanup);
const props = () => ({
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
    isNew: false,
    hasError: false,
    aiGenerated: true,
    onPreviewClick: vi.fn(),
    onNodeClick: vi.fn(),
  },
});
describe("Page Map route previews", () => {
  it("renders the mapped route and supports keyboard opening", () => {
    const input = props();
    render(<PageNode {...input} />);
    const frame = screen.getByTitle("Preview of Account");
    expect(frame.getAttribute("src")).toBe("/api/projects/901/preview/account/profile");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.keyDown(screen.getByRole("button", { name: "Open preview: Account" }), {
      key: "Enter",
    });
    expect(input.data.onPreviewClick).toHaveBeenCalledWith(
      "src/pages/Account.tsx",
      "/account/profile",
    );
  });
  it("does not create a frame for an unsafe or unresolved route", () => {
    const input = props();
    render(<PageNode {...input} data={{ ...input.data, notes: "Route: //outside.test" }} />);
    expect(screen.queryByTitle("Preview of Account")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View page details: Account" }));
    expect(input.data.onPreviewClick).not.toHaveBeenCalled();
    expect(input.data.onNodeClick).toHaveBeenCalledWith("account");
  });
});
