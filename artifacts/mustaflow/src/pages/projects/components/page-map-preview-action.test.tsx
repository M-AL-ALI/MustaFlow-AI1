import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageMapPreviewAction } from "./page-map-preview-action";
import { PageDetailPanel, type PageMapNodeState } from "./page-detail-panel";

afterEach(cleanup);
const page: PageMapNodeState = {
  id: "note",
  label: "Note detail",
  pageType: "detail",
  filePath: "src/pages/notes/[id].tsx",
  notes: "Route: /notes/:id",
  position: { x: 0, y: 0 },
  isNew: false,
  hasError: false,
  aiGenerated: true,
};
const fill = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Example id" }), { target: { value } });

describe("Page Map example preview action", () => {
  it("keeps an overlong example editable and recovers without remounting", () => {
    const onOpenPreview = vi.fn();
    render(<PageMapPreviewAction projectId={901} node={page} onOpenPreview={onOpenPreview} />);
    const input = screen.getByRole("textbox", { name: "Example id" });
    fill("\u6f22".repeat(256));
    expect(screen.getByRole("textbox", { name: "Example id" })).toBe(input);
    expect(input).toHaveValue("\u6f22".repeat(256));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Shorten one or more values");
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).not.toHaveBeenCalled();
    fill("note-42");
    expect(screen.getByRole("textbox", { name: "Example id" })).toBe(input);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).toHaveBeenCalledExactlyOnceWith("/notes/note-42");
  });
  it("keeps all fields editable when combined example values overflow the route budget", () => {
    const onOpenPreview = vi.fn();
    render(
      <PageMapPreviewAction
        projectId={901}
        node={{ ...page, notes: "Route: /teams/:team/notes/:id" }}
        onOpenPreview={onOpenPreview}
      />,
    );
    const team = screen.getByRole("textbox", { name: "Example team" });
    const id = screen.getByRole("textbox", { name: "Example id" });
    fireEvent.change(team, { target: { value: "\u6f22".repeat(128) } });
    fireEvent.change(id, { target: { value: "\u6f22".repeat(128) } });
    expect(team).toHaveAttribute("aria-invalid", "true");
    expect(id).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("preview path too long");
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
    fireEvent.change(team, { target: { value: "alpha" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Example id" })).toBe(id);
    expect(id).toHaveValue("\u6f22".repeat(128));
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).toHaveBeenCalledExactlyOnceWith(
      "/teams/alpha/notes/" + encodeURIComponent("\u6f22".repeat(128)),
    );
  });
  it("opens only on explicit keyboard activation and never creates an iframe", async () => {
    const onOpenPreview = vi.fn();
    const user = userEvent.setup();
    render(<PageMapPreviewAction projectId={901} node={page} onOpenPreview={onOpenPreview} />);
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Example id" }), "note-42");
    expect(onOpenPreview).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Open in Preview" }).focus();
    await user.keyboard("{Enter}");
    expect(onOpenPreview).toHaveBeenCalledExactlyOnceWith("/notes/note-42");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Existing app sign-in and permissions still apply/)).toBeVisible();
  });
  it("explains invalid values and recovers after a correction", () => {
    const onOpenPreview = vi.fn();
    render(<PageMapPreviewAction projectId={901} node={page} onOpenPreview={onOpenPreview} />);
    fill("../other");
    expect(screen.getByRole("alert")).toHaveTextContent("Use a single ID or slug");
    expect(screen.getByRole("textbox", { name: "Example id" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).not.toHaveBeenCalled();
    fill("42");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).toHaveBeenCalledWith("/notes/42");
  });
  it.each(["project", "page", "route"])(
    "clears examples on %s changes and when returning to the old target",
    (kind) => {
      const onOpenPreview = vi.fn();
      const view = render(
        <PageMapPreviewAction projectId={901} node={page} onOpenPreview={onOpenPreview} />,
      );
      fill("private-record");
      const other =
        kind === "page"
          ? { ...page, id: "other" }
          : kind === "route"
            ? { ...page, notes: "Route: /other/:id" }
            : page;
      view.rerender(
        <PageMapPreviewAction
          projectId={kind === "project" ? 902 : 901}
          node={other}
          onOpenPreview={onOpenPreview}
        />,
      );
      expect(screen.getByRole("textbox", { name: "Example id" })).toHaveValue("");
      fill("second-record");
      view.rerender(
        <PageMapPreviewAction projectId={901} node={page} onOpenPreview={onOpenPreview} />,
      );
      expect(screen.getByRole("textbox", { name: "Example id" })).toHaveValue("");
      expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
      expect(onOpenPreview).not.toHaveBeenCalled();
    },
  );
  it("keeps the example through a same-target map label update", () => {
    const onOpenPreview = vi.fn();
    const view = render(
      <PageMapPreviewAction projectId={901} node={page} onOpenPreview={onOpenPreview} />,
    );
    fill("42");
    view.rerender(
      <PageMapPreviewAction
        projectId={901}
        node={{ ...page, label: "Renamed note" }}
        onOpenPreview={onOpenPreview}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Example id" })).toHaveValue("42");
  });
  it.each([
    { node: { ...page, planned: true }, projectId: 901, message: "Build this page" },
    { node: { ...page, filePath: "" }, projectId: 901, message: "mapped source file" },
    { node: page, projectId: 0, message: "Choose a project" },
    { node: { ...page, notes: "Route: //outside.test" }, projectId: 901, message: "concrete path" },
  ])("explains why an unavailable target cannot open: $message", ({ node, projectId, message }) => {
    const onOpenPreview = vi.fn();
    render(
      <PageMapPreviewAction projectId={projectId} node={node} onOpenPreview={onOpenPreview} />,
    );
    expect(screen.getByText(new RegExp(message))).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
  });
  it("opens static routes without an unnecessary example field", () => {
    const onOpenPreview = vi.fn();
    render(
      <PageMapPreviewAction
        projectId={901}
        node={{ ...page, notes: "Route: /notes" }}
        onOpenPreview={onOpenPreview}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).toHaveBeenCalledWith("/notes");
  });
  it("integrates with real page details without saving or overwriting a manual draft", () => {
    const onSave = vi.fn(),
      onModifyPage = vi.fn(),
      onOpenPreview = vi.fn(),
      onDraftStart = vi.fn();
    render(
      <PageDetailPanel
        node={page}
        projectId={901}
        onOpenPreview={onOpenPreview}
        onClose={vi.fn()}
        onSave={onSave}
        onFileOpen={vi.fn()}
        onModifyPage={onModifyPage}
        onDelete={vi.fn()}
        onDraftStart={onDraftStart}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Page name" }), {
      target: { value: "My unsaved title" },
    });
    expect(onDraftStart).toHaveBeenCalledTimes(1);
    fill("42");
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpenPreview).toHaveBeenCalledWith("/notes/42");
    expect(onSave).not.toHaveBeenCalled();
    expect(onModifyPage).not.toHaveBeenCalled();
    expect(onDraftStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Page name" })).toHaveValue("My unsaved title");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith({ ...page, label: "My unsaved title" });
  });
});
