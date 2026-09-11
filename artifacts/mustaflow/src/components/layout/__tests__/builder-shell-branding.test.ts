import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkspaceNavigation } from "../slide-out-nav";
afterEach(cleanup);

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(directory, "../slide-out-nav.tsx"), "utf8");

describe("NabuFlow builder shell branding", () => {
  it("uses the dedicated NabuFlow mark and wordmark", () => {
    expect(source).toContain('"/logos/nabuflow-icon.png"');
    expect(source).toContain('data-testid="nabuflow-corner-brand"');
    expect(source).toContain('aria-label="Open NabuFlow navigation"');
    expect(source).toContain(">NabuFlow</span>");
    expect(source).not.toContain('"/logo.png"');
    expect(source).not.toContain(">MustaFlow</span>");
  });

  it("hides the navigation trigger while the drawer logo is visible", () => {
    expect(source).toContain("aria-hidden={open}");
    expect(source).toContain('open ? "pointer-events-none opacity-0" : "opacity-100"');
  });
});

describe("NabuFlow responsive identity", () => {
  const props = {
    location: "/projects",
    isAdmin: false,
    renderWorkspace: () => null,
    account: null,
  };

  it("renders one dedicated mark and wordmark in the expanded desktop sidebar", () => {
    render(
      createElement(WorkspaceNavigation, {
        ...props,
        layout: { isDesktop: true, expanded: true, onToggle: () => {} },
      }),
    );
    const sidebar = screen.getByRole("complementary", { name: "NabuFlow sidebar" });
    expect(within(sidebar).getByText("NabuFlow", { exact: true })).toBeTruthy();
    const marks = sidebar.querySelectorAll("img");
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute("src")).toBe("/logos/nabuflow-icon.png");
    expect(screen.queryByRole("button", { name: "Open NabuFlow navigation" })).toBeNull();
  });

  it("keeps the compact desktop navigation free of duplicated branding or a hidden drawer trigger", () => {
    render(
      createElement(WorkspaceNavigation, {
        ...props,
        layout: { isDesktop: true, expanded: false, onToggle: () => {} },
      }),
    );
    expect(screen.getByRole("button", { name: "Expand workspace navigation" })).toBeTruthy();
    expect(screen.queryByText("NabuFlow", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open NabuFlow navigation" })).toBeNull();
  });

  it("uses the same dedicated mark in the smaller-screen trigger and named drawer", () => {
    render(createElement(WorkspaceNavigation, props));
    const trigger = screen.getByRole("button", { name: "Open NabuFlow navigation" });
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe("/logos/nabuflow-icon.png");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "NabuFlow" });
    expect(within(dialog).getByRole("heading", { name: "NabuFlow" })).toBeTruthy();
    expect(dialog.querySelectorAll("img")).toHaveLength(1);
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/logos/nabuflow-icon.png");
    expect(trigger.getAttribute("aria-hidden")).toBe("true");
  });
});
