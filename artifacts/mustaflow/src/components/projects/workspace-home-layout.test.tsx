import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkspaceHomeLayout } from "./workspace-home-layout";
afterEach(cleanup);
function view(name = "Product studio", onChooseWorkspace = vi.fn()) {
  return (
    <WorkspaceHomeLayout
      workspaceName={name}
      onChooseWorkspace={onChooseWorkspace}
      composer={
        <label>
          Describe your app
          <textarea />
        </label>
      }
      projects={<a href="/projects/901">Existing project</a>}
    />
  );
}
describe("Workspace home layout", () => {
  it("renders one composer and one collection without mounting duplicate project previews", () => {
    const { container } = render(view());
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Existing project" })).toHaveLength(1);
    expect(container.querySelector(".nf-workspace-create")).toContainElement(
      screen.getByRole("textbox"),
    );
    expect(container.querySelector(".nf-workspace-projects")).toContainElement(
      screen.getByRole("link", { name: "Existing project" }),
    );
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
  });
  it("offers a same-page keyboard-focusable project destination without starting a project", () => {
    render(view());
    const link = screen.getByRole("link", { name: "Browse projects" });
    const target = document.getElementById(link.getAttribute("href")!.slice(1));
    expect(target).toHaveAttribute("tabindex", "-1");
    expect(target).toContainElement(screen.getByRole("link", { name: "Existing project" }));
  });
  it("keeps workspace switching explicit and preserves the caller's input while rendering", () => {
    const choose = vi.fn();
    render(view("Product studio", choose));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
    expect(choose).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox")).toHaveValue("Unsent idea");
    expect(screen.getByText("Product studio")).toHaveAttribute("dir", "auto");
  });
  it("gives independently mounted homes distinct project jump targets", () => {
    render(
      <>
        {view("First")}
        {view("Second")}
      </>,
    );
    const homes = screen.getAllByRole("region", { name: "Workspace home" });
    const targets = homes.map((home) =>
      within(home).getByRole("link", { name: "Browse projects" }).getAttribute("href"),
    );
    expect(new Set(targets).size).toBe(2);
    for (const [i, home] of homes.entries())
      expect(home).toContainElement(document.getElementById(targets[i]!.slice(1)));
  });
});
