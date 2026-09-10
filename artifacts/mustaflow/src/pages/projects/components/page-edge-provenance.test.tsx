import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Position } from "@xyflow/react";
import { PageEdge, type ConnectionType } from "./page-edge";

vi.mock("@xyflow/react", () => ({
  getBezierPath: () => ["M0,0 L100,100", 50, 50],
  Position: { Left: "left", Right: "right" },
}));

afterEach(cleanup);

function renderEdge(
  aiGenerated: boolean,
  connectionType: ConnectionType = "nav",
  selected = false,
) {
  render(
    <svg>
      <PageEdge
        id="account-home"
        source="account"
        target="home"
        sourceX={0}
        sourceY={0}
        targetX={100}
        targetY={100}
        sourcePosition={Position.Right}
        targetPosition={Position.Left}
        selected={selected}
        data={{ connectionType, aiGenerated }}
      />
    </svg>,
  );
}

function badge() {
  return screen.getByRole("button", {
    name: "Inspect transition account-home: Action unknown -> condition unknown -> outcome unknown",
  });
}

describe("Page Map connection provenance", () => {
  it("labels AI connections as inferred with unknown details, not runtime proof", () => {
    renderEdge(true);
    expect(within(badge()).getByText("Inferred map; details unknown")).toBeVisible();
    const path = screen.getByRole("img", {
      name: /^Navigation: .*Inferred map; details unknown; runtime not verified\.$/,
    });
    expect(path).toHaveAttribute("stroke-dasharray", "5 4");
    expect(path).toHaveAccessibleName(expect.stringContaining("condition unknown"));
    expect(path).toHaveAccessibleName(expect.stringContaining("outcome unknown"));
  });

  it("labels manually mapped connections without treating them as verified", () => {
    renderEdge(false);
    expect(within(badge()).getByText("Mapped; details unknown")).toBeVisible();
    const path = screen.getByRole("img", {
      name: /^Navigation: .*Mapped; details unknown; runtime not verified\.$/,
    });
    expect(path).toHaveAttribute("stroke", "hsl(var(--muted-foreground))");
    expect(path).toHaveAccessibleName(expect.stringContaining("Action unknown"));
  });

  it.each([true, false])(
    "keeps access-gate provenance and a decorative lock (inferred: %s)",
    (inferred) => {
      renderEdge(inferred, "auth-gate");
      expect(
        within(badge()).getByText(
          inferred ? "Inferred map; details unknown" : "Mapped; details unknown",
        ),
      ).toBeVisible();
      const path = screen.getByRole("img", {
        name: /^Access gate: .*details unknown; runtime not verified\.$/,
      });
      expect(path).toBeInTheDocument();
      expect(path).toHaveAttribute("stroke-dasharray", inferred ? "5 4" : "6 3");
      expect(badge().querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(within(badge()).queryByRole("img")).toBeNull();
    },
  );

  it("uses the single accent for selection without changing evidence", () => {
    renderEdge(false, "redirect", true);
    expect(
      screen.getByRole("img", {
        name: /^Redirect: .*Mapped; details unknown; runtime not verified\.$/,
      }),
    ).toHaveAttribute("stroke", "hsl(var(--primary))");
    expect(within(badge()).getByText("Mapped; details unknown")).toBeVisible();
  });
});
