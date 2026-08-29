import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallCard } from "./tool-call-card";

describe("ToolCallCard visual evidence", () => {
  it("shows Zero's durable screenshot with its honest phase and pair", () => {
    render(
      <ToolCallCard
        event={{
          id: 17,
          eventType: "visual_evidence",
          message: JSON.stringify({
            assetId: 91,
            contentUrl: "/api/assets/91/content",
            phase: "before",
            pairId: "hero-change",
            label: "Before",
          }),
        }}
      />,
    );

    expect(screen.getByText("Before · hero-change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("img", { name: "Before" })).toHaveAttribute(
      "src",
      "/api/assets/91/content",
    );
    expect(screen.getByText("Saved with this project")).toBeInTheDocument();
  });

  it("never renders a raw evidence payload as user copy", () => {
    render(
      <ToolCallCard
        event={{
          id: 18,
          eventType: "visual_evidence",
          message: JSON.stringify({
            assetId: 92,
            contentUrl: "/api/assets/92/content",
            phase: "after",
            pairId: "card-change",
            label: "After",
          }),
        }}
      />,
    );
    expect(screen.queryByText(/assetId/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/contentUrl/u)).not.toBeInTheDocument();
  });
});
