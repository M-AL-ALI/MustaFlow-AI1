import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectDashboard, type DashboardProject } from "./project-dashboard";

vi.mock("./project-card-snapshot", () => ({ ProjectCardSnapshot: () => null }));
afterEach(cleanup);

const projects: DashboardProject[] = Array.from({ length: 25 }, (_, index) => ({
  id: 900 + index,
  name: "Project " + String(index + 1).padStart(2, "0"),
  description: index === 24 ? "Older searchable project" : "Workspace example",
  status: index === 24 ? "paused" : index === 23 ? "ready" : "draft",
  updatedAt: new Date(Date.UTC(2026, 8, 25 - index)).toISOString(),
}));

function input() {
  return {
    collectionScope: "workspace" as const,
    projects,
    total: projects.length,
    state: "ready" as const,
    onRetry: vi.fn(),
    onTrash: vi.fn(),
  };
}

describe("workspace project collection", () => {
  it("resets when returning to earlier status and sort selections", () => {
    render(<ProjectDashboard {...input()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    const filter = screen.getByLabelText("Filter projects by status");
    fireEvent.change(filter, { target: { value: "ready" } });
    fireEvent.change(filter, { target: { value: "all" } });
    expect(screen.getAllByRole("article")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    const sort = screen.getByLabelText("Sort projects");
    fireEvent.change(sort, { target: { value: "name" } });
    fireEvent.change(sort, { target: { value: "recent" } });
    expect(screen.getAllByRole("article")).toHaveLength(12);
  });

  it("preserves expanded results when only the layout changes", () => {
    render(<ProjectDashboard {...input()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getAllByRole("article")).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getAllByRole("article")).toHaveLength(24);
  });

  it("resets the batch when collection scope changes back to an earlier scope", () => {
    const view = render(<ProjectDashboard {...input()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    view.rerender(<ProjectDashboard {...input()} collectionScope="recent" />);
    view.rerender(<ProjectDashboard {...input()} collectionScope="workspace" />);
    expect(screen.getAllByRole("article")).toHaveLength(12);
  });

  it("bounds cards without starting every runtime and progressively reveals all matches", () => {
    const { container } = render(<ProjectDashboard {...input()} />);
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(screen.getByText("Showing 12 of 25 matching workspace projects")).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    const more = screen.getByRole("button", { name: "Show more projects" });
    expect(document.getElementById(more.getAttribute("aria-controls")!)).toBeTruthy();
    fireEvent.click(more);
    expect(screen.getAllByRole("article")).toHaveLength(24);
    fireEvent.click(more);
    expect(screen.getAllByRole("article")).toHaveLength(25);
    expect(
      screen.getByRole("button", { name: "All matching projects shown" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("searches older projects beyond the rendered batch and resets the batch when search changes", () => {
    render(<ProjectDashboard {...input()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    const search = screen.getByRole("searchbox", { name: "Search all workspace projects" });
    fireEvent.change(search, { target: { value: "Older searchable" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "Project 25" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear project search" }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
  });

  it.each([
    ["ready", "Project 24"],
    ["paused", "Project 25"],
  ])(
    "includes the %s filter even when matching projects are outside the first batch",
    (status, name) => {
      render(<ProjectDashboard {...input()} />);
      fireEvent.change(screen.getByLabelText("Filter projects by status"), {
        target: { value: status },
      });
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.getByRole("article", { name })).toBeTruthy();
    },
  );

  it("keeps partial API collections explicitly recent rather than claiming global search", () => {
    render(<ProjectDashboard {...input()} total={100} />);
    expect(screen.getByRole("searchbox", { name: "Search recent projects" })).toBeTruthy();
    expect(screen.getByText(/Filters apply to these projects/)).toBeTruthy();
    expect(screen.queryByRole("searchbox", { name: "Search all workspace projects" })).toBeNull();
  });

  it("resets the rendered batch on sort changes and keeps input data unchanged", () => {
    render(<ProjectDashboard {...input()} projects={Object.freeze([...projects])} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    fireEvent.change(screen.getByLabelText("Sort projects"), { target: { value: "name" } });
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(projects[0].name).toBe("Project 01");
  });

  it("reports no matches without misreporting an empty workspace", () => {
    render(<ProjectDashboard {...input()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unmatched" } });
    expect(screen.getByText("No matching projects")).toBeTruthy();
    expect(screen.queryByText("A place for your next idea")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more projects" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
  });
});
