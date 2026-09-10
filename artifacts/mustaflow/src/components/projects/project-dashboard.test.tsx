import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ProjectDashboard,
  projectDate,
  projectStatusLabel,
  selectRecentProjects,
  type DashboardProject,
} from "./project-dashboard";

afterEach(cleanup);
const projects: DashboardProject[] = [
  {
    id: 901,
    name: "Cedar bookings",
    description: "Appointments for a small business",
    status: "published",
    updatedAt: "2026-09-08T10:00:00Z",
    healthScore: 92,
  },
  {
    id: 902,
    name: "Atlas workspace",
    description: "Team projects",
    status: "failed",
    updatedAt: "2026-09-07T10:00:00Z",
  },
];
const props = () => ({
  projects,
  total: 2,
  state: "ready" as const,
  onRetry: vi.fn(),
  onTrash: vi.fn(),
});

describe("Project dashboard interactions", () => {
  it.each(["loading", "error", "ready"] as const)(
    "keeps owner Trash available in the %s state, including an empty account",
    (state) => {
      render(<ProjectDashboard {...props()} projects={[]} total={0} state={state} />);
      expect(screen.getByRole("link", { name: "Open Trash" }).getAttribute("href")).toBe("/trash");
    },
  );

  it("retries an error without exposing an internal exception or pretending data is empty", () => {
    const input = props();
    render(<ProjectDashboard {...input} state="error" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(input.onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText("A place for your next idea")).toBeNull();
  });

  it("searches and filters only the declared recent-project set", () => {
    render(<ProjectDashboard {...props()} total={12} />);
    expect(screen.getByText(/Filters apply to these projects/)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search recent projects" }), {
      target: { value: "CEDAR" },
    });
    expect(screen.getByRole("article", { name: "Cedar bookings" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Atlas workspace" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter projects by status"), {
      target: { value: "attention" },
    });
    expect(screen.getByText("No matching projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("never loads all project runtimes on dashboard arrival and allows only one requested preview", () => {
    const { container } = render(<ProjectDashboard {...props()} />);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Preview Cedar bookings" }));
    const first = screen.getByTitle("Project preview: Cedar bookings");
    expect(first.getAttribute("src")).toBe("/api/projects/901/preview/index.html");
    expect(first.getAttribute("sandbox")).toBe("allow-scripts");
    expect(first.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.click(screen.getByRole("button", { name: "Preview Atlas workspace" }));
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(screen.queryByTitle("Project preview: Cedar bookings")).toBeNull();
    expect(screen.getByText(/not a deployment health check/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview: Atlas workspace" }));
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("uses separate links and action controls, rather than nested buttons", () => {
    const input = props();
    const { container } = render(<ProjectDashboard {...input} />);
    expect(screen.getByRole("link", { name: "Cedar bookings" }).getAttribute("href")).toBe(
      "/projects/901",
    );
    expect(container.querySelectorAll("a button, button button")).toHaveLength(0);
    const actions = screen.getByLabelText("Actions for Cedar bookings");
    fireEvent.click(actions);
    fireEvent.click(actions.parentElement!.querySelector("button")!);
    expect(input.onTrash).toHaveBeenCalledWith(projects[0]);
  });

  it("changes layout and does not turn missing health evidence into zero", () => {
    render(<ProjectDashboard {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "List view" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByText("Health 0/100")).toBeNull();
    expect(screen.getByText("Health 92/100")).toBeTruthy();
  });
});

describe("Project presentation contracts", () => {
  it("sorts without changing the API array", () => {
    expect(selectRecentProjects(projects, "", "all", "name").map((p) => p.id)).toEqual([902, 901]);
    expect(projects.map((p) => p.id)).toEqual([901, 902]);
  });
  it("does not invent readiness or a valid date for an unknown value", () => {
    expect(projectStatusLabel("something-new")).toBe("Status unavailable");
    expect(projectStatusLabel("failed")).toBe("Needs attention");
    expect(projectDate("not-a-date")).toBe("Date unavailable");
  });
});
